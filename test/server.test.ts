import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {listProjects, getProject, listItems, makeGraphql, makeWatsonGraphql, addProjectV2ItemById, updateProjectV2ItemFieldValue, deleteProjectV2Item} from '../src/github.ts';
test('startup refuses Watson bridge in write mode', () => { const result = spawnSync(process.execPath, ['--import','tsx','src/index.ts'], {cwd:process.cwd(), env:{...process.env, GITHUB_PROJECTS_V2_WRITE_ENABLED:'true', WATSON_GH_PATH:'watson-gh', GITHUB_APP_ID:'1', GITHUB_APP_PRIVATE_KEY:'key', GITHUB_INSTALLATION_ID:'2'}, encoding:'utf8'}); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /WATSON_GH_PATH is not permitted/); });

const writeEnv = {GITHUB_PROJECTS_V2_WRITE_ENABLED:'true', GITHUB_PROJECTS_V2_WRITE_ALLOWLIST:'[{"organization":"acme","projectId":"PVT_1"}]'};
test('project writes are disabled and fail closed by default', async () => {
  let calls = 0; const g = async () => { calls++; return {}; };
  await assert.rejects(() => addProjectV2ItemById(g, {}, 'acme', 'PVT_1', 'I_1'), /disabled/);
  await assert.rejects(() => addProjectV2ItemById(g, {...writeEnv, GITHUB_PROJECTS_V2_WRITE_ALLOWLIST:'bad'}, 'acme', 'PVT_1', 'I_1'), /allowlist/);
  assert.equal(calls, 0);
});
test('project writes enforce exact organization and project allowlist', async () => {
  const g = async () => { throw new Error('must not call'); };
  await assert.rejects(() => deleteProjectV2Item(g, writeEnv, 'other', 'PVT_1', 'I_1'), /not allowlisted/);
  await assert.rejects(() => deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_2', 'I_1'), /not allowlisted/);
});
test('allowed project writes use the expected GraphQL mutations', async () => {
  const seen:string[] = []; let deleted=false; const g = async (query:string, variables:any) => { seen.push(query); if (variables.projectId) assert.equal(variables.projectId, 'PVT_1'); if (query.includes('organization(login')) return {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}}; if (query.includes('fields(first:100')) return {node:{fields:{nodes:[{id:'F_1'}],pageInfo:{hasNextPage:false,endCursor:null}}}}; if (query.startsWith('query')) return {node:{items:{nodes:deleted?[]:[{id:'I_1',content:{id:'OTHER'},fieldValues:{nodes:[{field:{id:'F_1'},text:'Todo'}],pageInfo:{hasNextPage:false,endCursor:null}}}],pageInfo:{hasNextPage:false,endCursor:null}}}}; if (query.includes('deleteProjectV2Item')) deleted=true; return {addProjectV2ItemById:{item:{id:'I_1'},errors:[]},updateProjectV2ItemFieldValue:{projectV2Item:{id:'I_1'},errors:[]},deleteProjectV2Item:{deletedItemId:'I_1',errors:[]}}; };
  await addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', 'CONTENT_1');
  await updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_1', {text:'Todo'});
  await deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_1', 'I_1');
  assert.ok(seen.some(q => q.includes('addProjectV2ItemById'))); assert.ok(seen.some(q => q.includes('updateProjectV2ItemFieldValue'))); assert.ok(seen.some(q => q.includes('deleteProjectV2Item')));
});
test('repeated add returns the existing item without a second mutation', async () => {
  let mutations = 0; const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.startsWith('query') ? {node:{items:{nodes:[{id:'I_1',content:{id:'CONTENT_1'},fieldValues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : (mutations++, {});
  const result = await addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', 'CONTENT_1');
  assert.equal(result.alreadyExists, true); assert.equal(result.item.id, 'I_1'); assert.equal(mutations, 0);
});
test('repeated delete of an absent item is a safe no-op', async () => {
  let mutations = 0; const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.startsWith('query') ? {node:{items:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}} : (mutations++, {});
  const result = await deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_1', 'I_1');
  assert.deepEqual(result, {deletedItemId:'I_1',errors:[],alreadyAbsent:true}); assert.equal(mutations, 0);
});
test('write validation rejects empty ids and ambiguous field values', async () => {
  const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : {};
  await assert.rejects(() => addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', ''), /contentId/);
  await assert.rejects(() => updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I', 'F', {text:'x',number:1}), /Exactly one/);
});
test('GraphQL mutation errors are surfaced without retrying', async () => {
  let calls = 0; const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.startsWith('query') ? {node:{items:{nodes:[{id:'I_1',content:{id:'C'},fieldValues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : (calls++, {deleteProjectV2Item:{errors:[{message:'forbidden'}]}});
  await assert.rejects(() => deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_1', 'I_1'), /permission denied|forbidden/);
  assert.equal(calls, 1);
});

test('native App auth invokes installation token flow', async () => {
  let requested = ''; let authCalls = 0;
  const g = makeGraphql({GITHUB_APP_ID:'1', GITHUB_APP_PRIVATE_KEY:'key', GITHUB_INSTALLATION_ID:'2'}, async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, 'bearer app-token');
    return new Response(JSON.stringify({data:{organization:{projectsV2:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}), {status:200});
  }, undefined, (_opts:any) => { authCalls++; return async (args:any) => { requested = args.type; return {token:'app-token'}; }; });
  await listProjects(g, 'acme'); assert.equal(authCalls, 1); assert.equal(requested, 'installation');
});
test('graphql awaits injectable token provider', async () => { let calls = 0; const g = makeGraphql({}, async (_url, init) => { assert.equal((init?.headers as Record<string,string>).authorization, 'bearer short-lived-test-token'); return new Response(JSON.stringify({data:{organization:{projectsV2:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}), {status:200}); }, async () => { calls++; return 'short-lived-test-token'; }); await listProjects(g, 'acme'); assert.equal(calls, 1); });
test('child bridge reports missing executable safely', async () => { await assert.rejects(() => listProjects(makeWatsonGraphql('/definitely/missing/watson-gh'), 'acme'), /watson-gh unavailable/); });
test('projects preserve pagination', async () => { const g = async () => ({organization:{projectsV2:{nodes:[{number:1}],pageInfo:{hasNextPage:true,endCursor:'abc'}}}}); assert.deepEqual(await listProjects(g, 'acme'), {nodes:[{number:1}],pageInfo:{hasNextPage:true,endCursor:'abc'}}); });
test('missing project is explicit', async () => { await assert.rejects(() => getProject(async () => ({organization:{projectV2:null}}), 'acme', 9), /not found or not visible/); });
test('permission errors and redacted content are preserved', async () => { const g = async () => ({organization:{projectV2:{items:{nodes:[{content:null,fieldValues:{nodes:[]}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}); assert.equal((await listItems(g, 'acme', 1)).nodes[0].content, null); await assert.rejects(() => listItems(async () => { throw new Error('Resource not accessible by integration'); }, 'acme', 1), /permission denied/); });
test('item field values retain association and nested pagination', async () => {
  const g = async () => ({
    organization: { projectV2: { items: {
      nodes: [{fieldValues: {nodes: [{id:'value-1', name:'Todo', field:{id:'field-1', name:'Status'}}], pageInfo:{hasNextPage:true, endCursor:'field-cursor'}}}],
      pageInfo: {hasNextPage:false, endCursor:null}
    }}}
  });
  const result = await listItems(g, 'acme', 1);
  assert.deepEqual(result.nodes[0].fieldValues.pageInfo, {hasNextPage:true, endCursor:'field-cursor'});
  assert.deepEqual(result.nodes[0].fieldValues.nodes[0].field, {id:'field-1', name:'Status'});
});
test('graphql timeout is surfaced', async () => { await assert.rejects(() => listProjects(async () => { throw new Error('timeout'); }, 'acme'), /timed out/); });

test('projectItems query uses literal variables and paginates beyond 100 items', async () => {
  const queries:string[] = []; const cursors:(string|null)[] = []; let call = 0;
  const g = async (query:string, variables:any) => { queries.push(query); cursors.push(variables.cursor); if (query.includes('organization(login')) return {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}}; assert.match(query, /query\(\$projectId:ID!,\$cursor:String\)/); assert.doesNotMatch(query, /\\\$projectId|\\\$cursor/); call++; return {node:{items:{nodes:Array.from({length:100},(_,i)=>({id:`I${(call-1)*100+i}`,content:call===3&&i===0?{id:'missing'}:undefined,fieldValues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}})),pageInfo:{hasNextPage:call<3,endCursor:call<3?`c${call}`:null}}}}; };
  await addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', 'missing');
  assert.deepEqual(cursors, [null, null, 'c1', 'c2']); assert.equal(queries.length, 4);
});
test('project authorization paginates beyond 100 projects and rejects owner mismatch', async () => {
  let page = 0; const g = async (_query:string, variables:any) => { page++; assert.equal(variables.cursor, page === 1 ? null : 'p1'); return {organization:{projectsV2:{nodes:page === 1 ? Array.from({length:100},(_,i)=>({id:`P${i}`,owner:{login:'acme'}})) : [{id:'PVT_1',owner:{login:'other'}}],pageInfo:{hasNextPage:page===1,endCursor:page===1?'p1':null}}}}; };
  await assert.rejects(() => deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_1', 'I_1'), /not visible/);
});
test('null mutation payloads and invalid field values are rejected', async () => {
  const base = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.includes('fields(first:100') ? {node:{fields:{nodes:[{id:'F_1',options:[{id:'O_1'}]}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.startsWith('query') ? {node:{items:{nodes:[{id:'I_1',fieldValues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : {updateProjectV2ItemFieldValue:null};
  await assert.rejects(() => updateProjectV2ItemFieldValue(base, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_1', {singleSelectOptionId:'O_2'}), /not valid/);
  await assert.rejects(() => updateProjectV2ItemFieldValue(base, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_2', {text:'x'}), /not a field/);
  const nullPayload = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.startsWith('query') ? {node:{items:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}} : {addProjectV2ItemById:null};
  await assert.rejects(() => addProjectV2ItemById(nullPayload, writeEnv, 'acme', 'PVT_1', 'C_1'), /no payload/);
});

test('typed post-write verification covers status, iteration, text, number, and mismatch', async () => {
  const run = async (value:any, actual:any, shouldPass=true) => {
    const g = async (query:string) => {
      if (query.includes('organization(login')) return {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}};
      if (query.includes('fields(first:100')) return {node:{fields:{nodes:[{id:'F_1',options:[{id:'O_1'}]}],pageInfo:{hasNextPage:false,endCursor:null}}}};
      if (query.includes('updateProjectV2ItemFieldValue')) return {updateProjectV2ItemFieldValue:{projectV2Item:{id:'I_1'}}};
      return {node:{items:{nodes:[{id:'I_1',fieldValues:{nodes:[{field:{id:'F_1'},...actual}],pageInfo:{hasNextPage:false,endCursor:null}}}],pageInfo:{hasNextPage:false,endCursor:null}}}};
    };
    if (shouldPass) await updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_1', value);
    else await assert.rejects(() => updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_1', value), /could not be confirmed/);
  };
  await run({singleSelectOptionId:'O_1'}, {optionId:'O_1'});
  await run({iterationId:'IT_1'}, {iterationId:'IT_1'});
  await run({text:'hello'}, {text:'hello'});
  await run({number:42}, {number:42});
  await run({singleSelectOptionId:'O_1'}, {optionId:'O_2'}, false);
});

test('nested field-value pagination is fail-closed during post-write verification', async () => {
  const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1',owner:{login:'acme'}}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.includes('fields(first:100') ? {node:{fields:{nodes:[{id:'F_1'}],pageInfo:{hasNextPage:false,endCursor:null}}}} : query.includes('updateProjectV2ItemFieldValue') ? {updateProjectV2ItemFieldValue:{projectV2Item:{id:'I_1'}}} : {node:{items:{nodes:[{id:'I_1',fieldValues:{nodes:[],pageInfo:{hasNextPage:true,endCursor:null}}}],pageInfo:{hasNextPage:false,endCursor:null}}}};
  await assert.rejects(() => updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_1', {text:'x'}), /pagination is incomplete/);
});
