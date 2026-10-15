import test from 'node:test'; import assert from 'node:assert/strict'; import {listProjects,getProject,listItems} from '../src/github.ts';
test('projects preserve pagination',async()=>{const g=async()=>({organization:{projectsV2:{nodes:[{number:1}],pageInfo:{hasNextPage:true,endCursor:'abc'}}}});assert.deepEqual(await listProjects(g,'acme'),{nodes:[{number:1}],pageInfo:{hasNextPage:true,endCursor:'abc'}})});
test('missing project is explicit',async()=>{await assert.rejects(()=>getProject(async()=>({organization:{projectV2:null}}),'acme',9),/not found or not visible/)});
test('permission errors are classified and redaction is retained',async()=>{const g=async()=>{throw new Error('Resource not accessible by integration')};await assert.rejects(()=>listItems(g,'acme',1),/permission denied/);assert.equal(({content:null}).content,null)});
test('graphql timeout is surfaced',async()=>{await assert.rejects(()=>listProjects(async()=>{throw new Error('timeout')},'acme'),/timed out/)});
