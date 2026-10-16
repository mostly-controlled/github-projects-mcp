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
  const seen:string[] = []; let deleted=false; const g = async (query:string, variables:any) => { seen.push(query); if (variables.projectId) assert.equal(variables.projectId, 'PVT_1'); if (query.includes('organization(login')) return {organization:{projectsV2:{nodes:[{id:'PVT_1'}]}}}; if (query.includes('fields(first:100)')) return {node:{fields:{nodes:[{id:'F_1'}]}}}; if (query.startsWith('query')) return {node:{items:{nodes:deleted?[]:[{id:'I_1',content:{id:'OTHER'}}]}}}; if (query.includes('deleteProjectV2Item')) deleted=true; return {addProjectV2ItemById:{item:{id:'I_1'},errors:[]},updateProjectV2ItemFieldValue:{projectV2Item:{id:'I_1'},errors:[]},deleteProjectV2Item:{deletedItemId:'I_1',errors:[]}}; };
  await addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', 'CONTENT_1');
  await updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I_1', 'F_1', {text:'Todo'});
  await deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_1', 'I_1');
  assert.ok(seen.some(q => q.includes('addProjectV2ItemById'))); assert.ok(seen.some(q => q.includes('updateProjectV2ItemFieldValue'))); assert.ok(seen.some(q => q.includes('deleteProjectV2Item')));
});
test('repeated add returns the existing item without a second mutation', async () => {
  let mutations = 0; const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1'}]}}} : query.startsWith('query') ? {node:{items:{nodes:[{id:'I_1',content:{id:'CONTENT_1'}}]}}} : (mutations++, {});
  const result = await addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', 'CONTENT_1');
  assert.deepEqual(result, {item:{id:'I_1',content:{id:'CONTENT_1'}},errors:[],alreadyExists:true}); assert.equal(mutations, 0);
});
test('repeated delete of an absent item is a safe no-op', async () => {
  let mutations = 0; const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1'}]}}} : query.startsWith('query') ? {node:{items:{nodes:[]}}} : (mutations++, {});
  const result = await deleteProjectV2Item(g, writeEnv, 'acme', 'PVT_1', 'I_1');
  assert.deepEqual(result, {deletedItemId:'I_1',errors:[],alreadyAbsent:true}); assert.equal(mutations, 0);
});
test('write validation rejects empty ids and ambiguous field values', async () => {
  const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1'}]}}} : {};
  await assert.rejects(() => addProjectV2ItemById(g, writeEnv, 'acme', 'PVT_1', ''), /contentId/);
  await assert.rejects(() => updateProjectV2ItemFieldValue(g, writeEnv, 'acme', 'PVT_1', 'I', 'F', {text:'x',number:1}), /Exactly one/);
});
test('GraphQL mutation errors are surfaced without retrying', async () => {
  let calls = 0; const g = async (query:string) => query.includes('organization(login') ? {organization:{projectsV2:{nodes:[{id:'PVT_1'}]}}} : query.startsWith('query') ? {node:{items:{nodes:[{id:'I_1',content:{id:'C'}}]}}} : (calls++, {deleteProjectV2Item:{errors:[{message:'forbidden'}]}});
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
