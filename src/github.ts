import {createAppAuth} from '@octokit/auth-app';
import {spawn} from 'node:child_process';
import {graphQLError, page, type Graphql, type Variables} from './types.js';

const PROJECT = `id number title url shortDescription closed fields(first:100){nodes{__typename ... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2IterationField{id name} ... on ProjectV2SingleSelectField{id name options{id name}}} pageInfo{hasNextPage endCursor}}`;
const CHILD_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
export type TokenProvider = () => Promise<string>;
export type AppAuthFactory = typeof createAppAuth;

export function makeWatsonGraphql(path = process.env.WATSON_GH_PATH ?? 'watson-gh'): Graphql {
  return (query, variables) => new Promise((resolve, reject) => {
    const child = spawn(path, ['api', 'graphql', '--input', '-'], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; let stderr = ''; let size = 0; let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(error); } };
    const timer = setTimeout(() => fail(new Error('watson-gh request timed out')), CHILD_TIMEOUT_MS);
    const append = (target: 'stdout'|'stderr', chunk: Buffer) => { size += chunk.length; if (size > MAX_OUTPUT_BYTES) return fail(new Error('watson-gh response exceeded output limit')); if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString(); };
    child.stdout.on('data', chunk => append('stdout', chunk)); child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('error', error => fail(new Error(`watson-gh unavailable: ${error.message}`)));
    child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) return reject(new Error(`watson-gh failed (exit ${code ?? 'unknown'})`)); try { const body = JSON.parse(stdout); if (body.errors?.length) return reject(new Error(body.errors.map((e: any) => e.message).join('; '))); resolve(body.data); } catch { reject(new Error('watson-gh returned invalid JSON')); } });
    child.stdin.end(JSON.stringify({query, variables}));
  });
}

export function makeGraphql(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, tokenProvider?: TokenProvider, authFactory: AppAuthFactory = createAppAuth): Graphql {
  let getToken = tokenProvider;
  if (!getToken) { for (const key of ['GITHUB_APP_ID','GITHUB_APP_PRIVATE_KEY','GITHUB_INSTALLATION_ID'] as const) if (!env[key]) throw new Error(`Missing ${key}`); const auth = authFactory({appId:env.GITHUB_APP_ID!,privateKey:env.GITHUB_APP_PRIVATE_KEY!,installationId:env.GITHUB_INSTALLATION_ID! as any}); getToken = async () => (await auth({type:'installation'})).token; }
  return async (query:string, variables:Variables) => { const token = await getToken!(); const response = await fetcher('https://api.github.com/graphql',{method:'POST',headers:{accept:'application/vnd.github+json',authorization:`bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query,variables})}); const body = await response.json() as any; if(!response.ok||body.errors?.length) throw new Error(body.errors?.map((e:any)=>e.message).join('; ')||`HTTP ${response.status}`); return body.data; };
}
export async function listProjects(g:Graphql,organization:string,cursor?:string){try{const d=await g(`query($org:String!,$cursor:String){organization(login:$org){projectsV2(first:50,after:$cursor){nodes{${PROJECT}}pageInfo{hasNextPage endCursor}}}}`,{org:organization,cursor:cursor??null});return page(d.organization.projectsV2);}catch(e){throw graphQLError(e);}}
export async function getProject(g:Graphql,organization:string,number:number){try{const d=await g(`query($org:String!,$number:Int!){organization(login:$org){projectV2(number:$number){${PROJECT}}}}`,{org:organization,number});if(!d.organization.projectV2)throw new Error('Project not found or not visible');return d.organization.projectV2;}catch(e){throw graphQLError(e);}}
export async function listItems(g:Graphql,organization:string,number:number,cursor?:string){try{const query=`query($org:String!,$number:Int!,$cursor:String){organization(login:$org){projectV2(number:$number){items(first:50,after:$cursor){nodes{id type content{__typename ... on Issue{number title url repository{name url}} ... on PullRequest{number title url repository{name url}}} fieldValues(first:50){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{id name field{__typename ... on ProjectV2FieldCommon{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2SingleSelectField{id name}}} ... on ProjectV2ItemFieldTextValue{id text field{__typename ... on ProjectV2FieldCommon{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2SingleSelectField{id name}}} ... on ProjectV2ItemFieldNumberValue{id number field{__typename ... on ProjectV2FieldCommon{id name} ... on ProjectV2IterationField{id name} ... on ProjectV2SingleSelectField{id name}}}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;const d=await g(query,{org:organization,number,cursor:cursor??null});if(!d.organization.projectV2)throw new Error('Project not found or not visible');return page(d.organization.projectV2.items);}catch(e){throw graphQLError(e);}}

type WriteConfig = {organization:string; projectId:string}[];
export function writeConfig(env:NodeJS.ProcessEnv = process.env): WriteConfig {
  if (env.GITHUB_PROJECTS_V2_WRITE_ENABLED !== 'true') throw new Error('Project writes are disabled');
  try {
    const parsed = JSON.parse(env.GITHUB_PROJECTS_V2_WRITE_ALLOWLIST ?? '');
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((x:any) => !x || typeof x.organization !== 'string' || !x.organization || typeof x.projectId !== 'string' || !x.projectId)) throw new Error();
    return parsed;
  } catch { throw new Error('Project write allowlist is missing or invalid'); }
}
function authorizeWrite(env:NodeJS.ProcessEnv, organization:string, projectId:string) {
  if (!organization || !projectId || !writeConfig(env).some(x => x.organization === organization && x.projectId === projectId)) throw new Error('Project write target is not allowlisted');
}
async function mutation(g:Graphql, query:string, variables:Variables, name:string) {
  try { const d = await g(query, variables); const payload = d?.[name]; if (!payload) throw new Error(`${name} returned no payload`); const errors = payload.errors; if (errors?.length) throw new Error(errors.map((e:any)=>e.message).join('; ')); return payload; } catch (e) { throw graphQLError(e); }
}
async function projectItems(g:Graphql, projectId:string) {
  try { const nodes:any[]=[]; let cursor:string|null=null; for(let n=0;n<MAX_PAGES;n++){ const d=await g("query($projectId:ID!,$cursor:String){node(id:$projectId){... on ProjectV2 {items(first:100,after:$cursor){nodes{id content{id}} pageInfo{hasNextPage endCursor}}}}}",{projectId,cursor}); const items=d?.node?.items; if(!items) throw new Error('Project not found or not visible'); nodes.push(...(items.nodes??[])); const next=items.pageInfo?.hasNextPage?items.pageInfo.endCursor:null; if(next&&next===cursor) throw new Error('Project item pagination cursor did not advance'); cursor=next; if(!cursor)return nodes; } throw new Error('Project item pagination exceeded limit'); } catch(e){throw graphQLError(e);}
}
async function authorizeProject(g:Graphql, env:NodeJS.ProcessEnv, organization:string, projectId:string) { authorizeWrite(env,organization,projectId); let cursor:string|null=null; for(let n=0;n<MAX_PAGES;n++){ const d=await g("query($org:String!,$cursor:String){organization(login:$org){projectsV2(first:100,after:$cursor){nodes{id owner{... on Organization{login}}} pageInfo{hasNextPage endCursor}}}}",{org:organization,cursor}); const projects=d?.organization?.projectsV2; if(!projects) throw new Error('Organization not found or not visible'); const match=(projects.nodes??[]).find((p:any)=>p.id===projectId); if(match&&(!match.owner || match.owner.login===organization))return; const next=projects.pageInfo?.hasNextPage?projects.pageInfo.endCursor:null; if(next&&next===cursor)throw new Error('Project authorization pagination cursor did not advance'); cursor=next;if(!cursor)break;} throw new Error('Project is not visible in the requested organization'); }
export async function addProjectV2ItemById(g:Graphql, env:NodeJS.ProcessEnv, organization:string, projectId:string, contentId:string) {
  await authorizeProject(g, env, organization, projectId); if (!contentId) throw new Error('contentId is required');
  const existing = (await projectItems(g, projectId)).find((item:any) => item.content?.id === contentId);
  if (existing) return {item:existing, errors:[], alreadyExists:true};
  const result=await mutation(g,'mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}',{projectId,contentId},'addProjectV2ItemById'); if(!result.item?.id)throw new Error('addProjectV2ItemById returned no item'); const confirmed=(await projectItems(g,projectId)).find((x:any)=>x.id===result.item.id); if(!confirmed)throw new Error('addProjectV2ItemById could not be confirmed'); return {...result,item:confirmed};
}
export async function updateProjectV2ItemFieldValue(g:Graphql, env:NodeJS.ProcessEnv, organization:string, projectId:string, itemId:string, fieldId:string, value:{text?:string;number?:number;singleSelectOptionId?:string;iterationId?:string}) {
  await authorizeProject(g, env, organization, projectId); if (!itemId || !fieldId || !value || Object.keys(value).length !== 1) throw new Error('Exactly one field value is required');
  const key = Object.keys(value)[0]; if (!['text','number','singleSelectOptionId','iterationId'].includes(key)) throw new Error('Unsupported field value');
  const fields=await g('query($projectId:ID!){node(id:$projectId){... on ProjectV2 {fields(first:100){nodes{... on ProjectV2FieldCommon{id} ... on ProjectV2IterationField{id} ... on ProjectV2SingleSelectField{id options{id}}}}}}}',{projectId}); const field=(fields?.node?.fields?.nodes??[]).find((f:any)=>f.id===fieldId); if(!field) throw new Error('fieldId is not a field on this project'); if(value.singleSelectOptionId && !(field.options??[]).some((o:any)=>o.id===value.singleSelectOptionId)) throw new Error('singleSelectOptionId is not valid for this field'); const result=await mutation(g,'mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}',{input:{projectId,itemId,fieldId,value}},'updateProjectV2ItemFieldValue'); if(!result.projectV2Item?.id) throw new Error('updateProjectV2ItemFieldValue returned no item'); const confirmed=(await projectItems(g,projectId)).find((x:any)=>x.id===itemId); if(!confirmed) throw new Error('updated item could not be confirmed'); return result;
}
export async function deleteProjectV2Item(g:Graphql, env:NodeJS.ProcessEnv, organization:string, projectId:string, itemId:string) {
  await authorizeProject(g, env, organization, projectId); if (!itemId) throw new Error('itemId is required');
  const existing = (await projectItems(g, projectId)).find((item:any) => item.id === itemId);
  if (!existing) return {deletedItemId:itemId, errors:[], alreadyAbsent:true};
  const result=await mutation(g,'mutation($projectId:ID!,$itemId:ID!){deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}',{projectId,itemId},'deleteProjectV2Item'); if(result.deletedItemId!==itemId) throw new Error('deleteProjectV2Item returned unexpected item'); const confirmed=(await projectItems(g,projectId)).find((x:any)=>x.id===itemId); if(confirmed) throw new Error('deleteProjectV2Item could not be confirmed'); return result;
}
