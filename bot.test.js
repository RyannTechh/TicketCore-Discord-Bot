'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { loadConfig } = require('./config');
const root = __dirname;
const localRequire = createRequire(path.join(root, 'index.js'));
const env = { DISCORD_TOKEN: 'synthetic-test-token' };
for (const key of ['CLIENT_ID','GUILD_ID','SUPPORT_ROLE_ID','TICKET_CATEGORY_ID','TRANSCRIPT_CHANNEL_ID','RATING_CHANNEL_ID','ESCALATION_ROLE_ID','DUPLICATE_APPROVAL_CHANNEL_ID']) env[key] = '100000000000000001';

test('configuration rejects missing IDs and invalid timers without disclosing the token', () => {
    const config = loadConfig(env, root);
    assert.equal(config.BRAND_NAME, 'TicketCore');
    assert.equal(config.TICKET_INACTIVITY_CLOSE_HOURS, 72);
    for (const overrides of [{GUILD_ID:''}, {TICKET_INACTIVITY_WARN_HOURS:'NaN'}, {TICKET_INACTIVITY_WARN_HOURS:'72'}, {TICKET_DUPLICATE_SIMILARITY_THRESHOLD:'2'}]) {
        assert.throws(() => loadConfig({...env,...overrides},root), error => !error.message.includes(env.DISCORD_TOKEN));
    }
    assert.equal(loadConfig({...env, DATABASE_FILE:'legacy.sqlite', BRAND_NAME:'Community'},root).DATABASE_FILE,path.join(root,'legacy.sqlite'));
});

test('offline ticket lifecycle preserves storage, departments, legacy tickets, ratings and reopening', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketcore-test-'));
    const discord = localRequire('discord.js');
    const channels = new discord.Collection();
    const sent = [];
    let nextId = 10;
    const ownerId = '100000000000000002';
    const staffId = '100000000000000003';
    const archive = { isTextBased:()=>true, send:async payload=>{sent.push(payload);return {id:'100000000000000004'};}, messages:{fetch:async()=>({embeds:[]})} };
    const user = {id:ownerId,tag:'Test customer',send:async payload=>sent.push(payload)};
    const guild = {
        id:env.GUILD_ID,iconURL:()=>null,
        roles:{everyone:{id:env.GUILD_ID}},
        members:{fetch:async()=>({id:ownerId})},
        channels:{cache:channels,fetch:async()=>channels,create:async options=>{
            assert.equal(options.parent, env.TICKET_CATEGORY_ID);
            assert.ok(options.permissionOverwrites.some(p=>p.id===guild.id && p.deny.includes(discord.PermissionsBitField.Flags.ViewChannel)));
            const channel={...options,id:String(100+nextId++),guild,createdTimestamp:Date.now(),isTextBased:()=>true,
                send:async payload=>{sent.push(payload);return {id:'test-message'};},
                delete:async()=>channels.delete(channel.id)};
            channels.set(channel.id,channel); return channel;
        }}
    };
    class OfflineClient {
        constructor(options) { this.options=options;this.user={id:'100000000000000009'};this.channels={fetch:async id=>channels.get(id)||archive};this.users={fetch:async()=>user};this.guilds={fetch:async()=>guild}; }
        on() {} once() {} isReady(){return true;}
        login(){throw new Error('Network login forbidden in tests');}
    }
    class OfflineREST { setToken(){return this;} put(){throw new Error('Command deployment forbidden in tests');} }
    function safeRequire(name) {
        if(name==='discord.js') return {...discord,Client:OfflineClient,REST:OfflineREST};
        if(name==='dotenv') return {config(){}};
        if(name==='discord-html-transcripts') return {createTranscript:async()=>({name:'test.html',attachment:Buffer.from('test transcript')})};
        return localRequire(name);
    }
    safeRequire.resolve=localRequire.resolve;
    const context=vm.createContext({require:safeRequire,__dirname:root,Buffer,console,
        process:{env:{...env,DATABASE_FILE:path.join(temp,'test.sqlite')},exit(){throw new Error('Unexpected exit');}},
        setTimeout:()=>0,setInterval:()=>({unref(){}})});
    const source=fs.readFileSync(path.join(root,'index.js'),'utf8');
    assert.ok(source.trimEnd().endsWith('startBot();'));
    vm.runInContext(source.replace(/startBot\(\);\s*$/, ''),context,{filename:'index.js'});
    const api=vm.runInContext('({initializeDatabase,openTicketChannel,getTicketRecord,getCurrentTicketCounter,findPotentialDuplicate,getStaffStats,changeStaffStats,isTicketChannel,handleRatingButton,handleReopenButton,closeTicket,recordTicketMessageActivity,commands,client,CONSTANTS,TICKET_TYPES,buildTicketTopic,normalizePriority})',context);
    try {
        await api.initializeDatabase();
        assert.ok(api.client.options.intents.includes(discord.GatewayIntentBits.MessageContent));
        assert.deepEqual(Array.from(api.commands,c=>c.name),['ticket','ticketpanel','close','add','staffstats','priority','transfer','escalate']);
        assert.deepEqual(Object.keys(api.TICKET_TYPES),['general_support','report','partner']);
        assert.ok(api.TICKET_TYPES.store && api.TICKET_TYPES.nitro_boosts);
        for(const marker of ['TICKETCORE_TICKET','ETERNITY_TICKET','SPECTOR_TICKET']) assert.equal(api.isTicketChannel({topic:marker+' | Owner:'+ownerId}),true);
        assert.equal(api.isTicketChannel({topic:'ordinary channel'}),false);
        assert.equal(api.normalizePriority('high'),'HIGH');
        const results=[];
        for(const typeKey of Object.keys(api.TICKET_TYPES)) results.push(await api.openTicketChannel({guild,userId:ownerId,typeKey,subject:'Test support request',purchaseDescription:null}));
        assert.equal(api.getCurrentTicketCounter(),3);
        assert.equal(results[0].ticketId,'0000');
        const ticket=results[0];
        assert.equal(api.getTicketRecord(ticket.channel).status,'OPEN');
        assert.ok(api.findPotentialDuplicate(guild.id,ownerId,'general_support','Test support request'));
        api.changeStaffStats(guild.id,staffId,{claimed:1});
        assert.equal(api.getStaffStats(guild.id,staffId).tickets_claimed,1);
        await api.recordTicketMessageActivity({guild,channel:ticket.channel,author:{id:ownerId,bot:false}});
        assert.ok(api.getTicketRecord(ticket.channel).last_customer_message_at);
        await api.closeTicket(null,ticket.channel,{id:staffId,tag:'Test staff'});
        assert.equal(api.getTicketRecord(ticket.channel).status,'CLOSED');
        assert.equal(api.getStaffStats(guild.id,staffId).tickets_closed,1);
        let reply='';
        const rating={customId:`rate_ticket_${ticket.recordId}_5`,user:{id:staffId},reply:async p=>{reply=p.content;},update:async()=>{}};
        await api.handleRatingButton(rating);
        assert.match(reply,/belongs/);
        rating.user=user;
        await api.handleRatingButton(rating);
        assert.equal(api.getStaffStats(guild.id,staffId).rating_total,5);
        await api.handleRatingButton(rating);
        assert.match(reply,/already/);
        channels.clear();
        const reopen={customId:`reopen_ticket_${ticket.recordId}`,user,reply:async p=>{reply=p.content;}};
        await api.handleReopenButton(reopen);
        assert.match(reply,/has been reopened/);
        const reopened=channels.first();
        assert.equal(api.getTicketRecord(reopened).reopened_from_record_id,ticket.recordId);
        assert.equal(api.getTicketRecord(reopened).reopen_count,1);
        await api.handleReopenButton(reopen);
        assert.match(reply,/already been reopened/);
        assert.ok(sent.some(p=>p.embeds?.some(e=>e.data?.title==='PARTNERSHIP QUESTIONS')));
        vm.runInContext('db.database.close()',context);
        await api.initializeDatabase();
        assert.equal(api.getCurrentTicketCounter(),3);
        assert.equal(api.getStaffStats(guild.id,staffId).rating_total,5);
    } finally {
        vm.runInContext('db?.database.close()',context);
        fs.rmSync(temp,{recursive:true,force:true});
    }
});

test('real transcript renderer and patched image downloader work offline', async () => {
    const { Collection, ChannelType } = localRequire('discord.js');
    const transcripts = localRequire('discord-html-transcripts');
    const transcriptRequire = createRequire(localRequire.resolve('discord-html-transcripts'));
    const undici = transcriptRequire('undici');
    const previous = undici.getGlobalDispatcher();
    const mock = new undici.MockAgent();
    mock.disableNetConnect();
    undici.setGlobalDispatcher(mock);
    try {
        mock.get('https://example.invalid').intercept({path:'/image.png'}).reply(200,Buffer.from('test-image'),{headers:{'content-type':'image/png'}});
        const { downloadImageToDataURL } = transcriptRequire('./utils/utils');
        assert.equal(await downloadImageToDataURL('https://example.invalid/image.png'),'data:image/png;base64,dGVzdC1pbWFnZQ==');
        const channel = {id:'100000000000000001',name:'test-ticket',type:ChannelType.GuildText,
            guild:{name:'Test community',iconURL:()=>null},isDMBased:()=>false,isThread:()=>false,isVoiceBased:()=>false};
        const message={id:'100000000000000002',createdAt:new Date(),editedAt:null,
            author:{id:'100000000000000003',displayName:'Test customer',displayAvatarURL:()=>null,bot:false},
            content:'Please help with my test ticket.',mentions:{everyone:false},attachments:new Collection(),embeds:[],components:[],reactions:{cache:new Collection()}};
        const html = await transcripts.generateFromMessages([message],channel,{returnType:'string',saveImages:true,poweredBy:false});
        assert.match(html,/Please help with my test ticket/);
        assert.match(html,/test-ticket/);
    } finally { undici.setGlobalDispatcher(previous); await mock.close(); }
});

