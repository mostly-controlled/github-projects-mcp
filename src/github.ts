import {createAppAuth} from '@octokit/auth-app';
import {spawn} from 'node:child_process';
import {graphQLError, page, type Graphql, type Variables} from './types.js';
const PROJECT = `id number title url shortDescription closed fields(first:100){nodes{__typename ... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2IterationField{id name} ... on ProjectV2SingleSelectField{id name options{id name}}}}`;
export type TokenProvider = () => Promise<string>;
export function makeWatsonGraphql(path = process.env.WATSON_GH_PATH ?? '/home/openclaw/.local/bin/watson-gh'): Graphql {
  return (query, variables) => new Promise((resolve, reject) => {
    const child = spawn(path, ['api', 'graphql', '--input', '-'], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { if (code !== 0) return reject(new Error(stderr.trim() || `watson-gh exited ${code}`)); try { const body = JSON.parse(stdout); if (body.errors?.length) return reject(new Error(body.errors.map((e: any) => e.message).join('; '))); resolve(body.data); } catch { reject(new Error('watson-gh returned invalid JSON')); } });
    child.stdin.end(JSON.stringify({query, variables}));
  });
}
export function makeGraphql(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch, tokenProvider?: TokenProvider): Graphql {
  let getToken = tokenProvider;
  if (!getToken) { for (const key of ['GITHUB_APP_ID','GITHUB_APP_PRIVATE_KEY','GITHUB_INSTALLATION_ID'] as const) if (!env[key]) throw new Error(`Missing ${key}`); getToken = async () => ((await createAppAuth({appId:env.GITHUB_APP_ID!,privateKey:env.GITHUB_APP_PRIVATE_KEY!,installationId:env.GITHUB_INSTALLATION_ID! as any,type:'installation'})) as any).token; }
  return async (query:string, variables:Variables) => { const token = await getToken!(); const response = await fetcher('https://api.github.com/graphql',{method:'POST',headers:{accept:'application/vnd.github+json',authorization:`bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query,variables})}); const body = await response.json() as any; if(!response.ok||body.errors?.length) throw new Error(body.errors?.map((e:any)=>e.message).join('; ')||`HTTP ${response.status}`); return body.data; };
}
export async function listProjects(g:Graphql,organization:string,cursor?:string){try{const d=await g(`query($org:String!,$cursor:String){organization(login:$org){projectsV2(first:50,after:$cursor){nodes{${PROJECT}}pageInfo{hasNextPage endCursor}}}}`,{org:organization,cursor:cursor??null});return page(d.organization.projectsV2);}catch(e){throw graphQLError(e);}}
export async function getProject(g:Graphql,organization:string,number:number){try{const d=await g(`query($org:String!,$number:Int!){organization(login:$org){projectV2(number:$number){${PROJECT}}}}`,{org:organization,number});if(!d.organization.projectV2)throw new Error('Project not found or not visible');return d.organization.projectV2;}catch(e){throw graphQLError(e);}}
export async function listItems(g:Graphql,organization:string,number:number,cursor?:string){try{const d=await g(`query($org:String!,$number:Int!,$cursor:String){organization(login:$org){projectV2(number:$number){items(first:50,after:$cursor){nodes{id type content{__typename ... on Issue{number title url repository{name url}} ... on PullRequest{number title url repository{name url}}} fieldValues(first:50){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{name} ... on ProjectV2ItemFieldTextValue{text} ... on ProjectV2ItemFieldNumberValue{number}}} } pageInfo{hasNextPage endCursor}}}}}`,{org:organization,number,cursor:cursor??null});if(!d.organization.projectV2)throw new Error('Project not found or not visible');return page(d.organization.projectV2.items);}catch(e){throw graphQLError(e);}}
