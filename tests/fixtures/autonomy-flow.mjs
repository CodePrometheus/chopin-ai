import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import Sessions from '@deepseek-ai/dsh-session';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, createUserMessage, createToolResultMessage} from '@deepseek-ai/dsh-llm';
import {ChopinEvolution} from '@chopin/evolution-runtime';
import Gates from '@chopin/gate';
import * as report from '@chopin/report';
import * as toolset from '@chopin/toolset';
import * as authoring from '@chopin/evolution-authoring';
import * as observer from '@chopin/evolution-observer';
import * as evolutionTools from '@chopin/evolution-runtime/tools';

const [rootInput, mode] = process.argv.slice(2);
assert(rootInput && ['capture', 'reuse'].includes(mode));
const root = resolve(rootInput);
const workspace = join(root, 'workspace');
const require = createRequire(import.meta.url);
const toolsRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'));
const {default: SystemPrompt} = await import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-system-prompt')).href);
const repository = fileURLToPath(new URL('../..', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await mkdir(workspace, {recursive:true});
const inputFile = join(workspace, 'input.json');
const checker = join(workspace, 'check.mjs');
if (mode === 'capture') {
  await writeFile(inputFile, JSON.stringify({items:[3,5,7],total:0}));
  await writeFile(checker, [
    "import {readFile} from 'node:fs/promises';",
    "const data=JSON.parse(await readFile('input.json','utf8'));",
    "const calculated=data.items.reduce((sum,item)=>sum+item,0);",
    "console.log(JSON.stringify({reported:data.total,calculated}));",
    "if(data.total!==calculated)process.exit(7);",
  ].join('\n'));
}

const ctx = new Context();
let handle;
try {
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools);
  await ctx.plugin(Sessions);
  await ctx.plugin(Persistence, {root:join(root,'sessions'),compression:'none'});
  const gates = new Gates(ctx);
  const service = new ChopinEvolution(ctx, {
    eventsFile:join(root,'events.jsonl'),artifactsDir:join(root,'artifacts'),receiptsDir:join(root,'receipts'),
    chopinVersion:'0.1.0',dshVersion:'0.1.3-alpha.1',processGeneration:`process-${process.pid}`,
  });
  await ctx.plugin(observer);
  await ctx.plugin(toolset, {dirs:[join(repository,'toolsets')],toolsets:['engineering'],vars:{
    REPO_PATH:quote(workspace),TEST_COMMAND:`${quote(process.execPath)} ${quote(checker)}`,
  }});
  await ctx.plugin(report, {tool:{name:'submit_delivery',description:'Submit the checked result.',parameters:{
    type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}},
  }},gates:[{id:'verified',description:'The calculation must pass its real check.',satisfiedByTools:['run_tests']}]});
  assert(gates.guardedTools().includes('submit_delivery'));
  await ctx.plugin(authoring);
  await ctx.plugin(evolutionTools);
  const session = ctx.sessions.create(`flow-${mode}`, {meta:{cwd:workspace}});
  handle = await ctx.sessionPersistence.create(session.header);
  const agent = {id:session.id,session,ctx};
  session.append('turn/start',{turn:1});
  session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Verify the total against the source items before delivering the result.'}]}),{surfaceOp:'append'});
  let step = 0;
  /** The model turn that announces a tool call; the stored log only accepts calls it has advertised. */
  function advertise(step,callId,name,encoded) {
    const stream = new AssistantStreamAccumulator();
    const assembler = new BlockAssembler();
    const time = Date.now();
    for (const chunk of [
      {type:'block-start',index:0,blockType:'tool-call'},
      {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:encoded},
      {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:encoded}},
      {type:'finish',reason:{kind:'tool-calls'}},
    ]) assembler.push(stream.push({time,chunk}).chunk);
    session.append('assistant/message',{turn:1,step,
      message:createAssistantMessage({content:assembler.blocks(),source:{provider:'fixture',model:'fixture'}}),
      stream:stream.snapshot()},{surfaceOp:'append'});
  }
  async function call(name,args={}) {
    step += 1;
    const callId = `${mode}-${step}`;
    const encoded = JSON.stringify(args);
    session.append('step/start',{turn:1,step});
    advertise(step,callId,name,encoded);
    session.append('tool/call',{turn:1,step,callId,name,arguments:encoded});
    const result = await ctx.tools.execute({callId,name,arguments:args,agent,signal:new AbortController().signal});
    session.append('tool/result',{turn:1,step,message:createToolResultMessage({callId,isError:result.isError,content:result.content})},{surfaceOp:'append'});
    session.append('step/end',{turn:1,step});
    await service.events.readAll();
    return result;
  }

  let failures = 0;
  if (mode === 'capture') {
    const failed = await call('run_tests');
    assert.equal(failed.isError,true);
    assert(failed.content.some(block=>block.type==='text' && block.text.includes('exit 7')));
    const blocked = await call('submit_delivery',{summary:'The total is checked.'});
    assert.equal(blocked.isError,true);
    const observed = (await service.events.fold()).candidates;
    failures = observed.length;
    assert(observed.some(candidate=>candidate.signalKey.startsWith('sk1:tool-failure:run_tests:')));
    assert(observed.some(candidate=>candidate.signalKey.startsWith('sk1:gate-rejection:submit_delivery:')));
    const source = JSON.parse(await readFile(inputFile,'utf8'));
    source.total = source.items.reduce((sum,item)=>sum+item,0);
    await writeFile(inputFile,JSON.stringify(source));
  } else {
    const saved = JSON.parse(await readFile(join(root,'capture-result.json'),'utf8'));
    assert.notEqual(saved.pid,process.pid);
    const recorded = await ctx.sessionPersistence.open('flow-capture','read');
    try {
      const {events:durable} = await recorded.read();
      assert(durable.some(event=>event.type==='tool/result' && event.data.message.isError));
      assert.equal(durable.filter(event=>event.type==='approval/asked').length,0);
    } finally { await recorded.close(); }
    const index = await service.contextFor(agent);
    assert(index.listed.includes(saved.artifactId));
    const read = await call('experience_read',{artifactId:saved.artifactId});
    assert.equal(read.isError,false);
    assert.equal(read.value.body,saved.body);
  }
  assert.equal((await call('run_tests')).isError,false);
  assert.equal((await call('submit_delivery',{summary:'The reported total matches the source items.'})).isError,false);
  assert((await service.maintenanceContextFor(agent)).includes('evolution_experience_record'));
  const body = 'Recompute the aggregate from the original records, compare it with the reported value, and rerun the check after changing either input. Do not treat a failed check as successful delivery.';
  const captured = await call('evolution_experience_record',{
    slug:'verify-aggregate',kind:'skill',lesson:'Check reported totals against original records.',when:'validating derived totals',body,
  });
  assert.equal(captured.isError,false);
  assert.equal(captured.value.enabled,true);
  assert.equal(captured.value.authorization,'policy');
  assert(!(await service.maintenanceContextFor(agent)).includes('Before finishing, save at most one'));
  const projection = await service.events.fold();
  assert.equal(projection.artifacts.length,1);
  assert.equal(projection.artifacts[0].trust,'provisional');
  if(mode==='reuse') {
    for(let index=0;index<7;index+=1)assert.equal((await call('evolution_candidates_list')).isError,false);
    const candidate=projection.candidates.find(item=>item.id===captured.value.candidateId);
    assert(candidate);
    const denied=await call('evolution_candidate_classify',{candidateId:candidate.id,proposals:candidate.proposals});
    assert.equal(denied.isError,true);
    assert(denied.content.some(block=>block.type==='text' && block.text.includes('Maintenance budget exhausted')));
    assert.equal((await service.events.fold()).candidates.find(item=>item.id===candidate.id).state,candidate.state);
  }
  const approvalEvents = session.snapshotEvents().filter(event=>event.type==='approval/asked').length;
  assert.equal(approvalEvents,0);
  session.append('turn/end',{turn:1,reason:{kind:'stop'}});
  await handle.flush();
  const result = {pid:process.pid,mode,artifactId:captured.value.artifactId,body,failures,artifactCount:projection.artifacts.length,approvalEvents};
  if(mode==='capture')await writeFile(join(root,'capture-result.json'),JSON.stringify(result));
  else assert.equal(result.artifactId,JSON.parse(await readFile(join(root,'capture-result.json'),'utf8')).artifactId);
  console.log(JSON.stringify(result));
} finally {
  await handle?.close();
  await ctx.fiber.dispose();
}
