import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { storageApi, fixture, knowledge } from '../tests/helpers/storage-api-harness.mjs'
import { seedReadFixture } from '../tests/helpers/read-cost-fixture.mjs'
import { createMapContentPatch } from '../src/utils/mapContentPatch.mjs'
import { createContentPreconditions } from '../server/lib/contentPreconditions.mjs'

const [baselineArg, candidateArg, outputArg] = process.argv.slice(2)
if (!baselineArg || !candidateArg || !outputArg) throw Error('기준·후보의 격리 소스와 새 출력 디렉터리가 필요합니다.')
const roots = { baseline: path.resolve(baselineArg), candidate: path.resolve(candidateArg) }, out = path.resolve(outputArg)
await mkdir(out, { recursive: false })
const hash = (v) => createHash('sha256').update(v).digest('hex')
const stats = (values) => { const s = [...values].sort((a,b)=>a-b); return { n:s.length,p50:s[Math.ceil(s.length*.5)-1]??null,p95:s[Math.ceil(s.length*.95)-1]??null,max:s.at(-1)??null } }
const metrics = pathToFileURL(path.resolve(import.meta.dirname,'../tests/helpers/integration-cost-metrics.mjs')).href
const result = { startedAt:new Date().toISOString(), baselineSha:'10afee7555f3ee9810cd7280da72815c5d599a01',candidateSha:'258faefbb0d9cc87345ccd8075f490ec20ff361c',
  environment:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0].model,cores:os.cpus().length,memoryBytes:os.totalmem(),node:process.version,nodeExecutable:process.execPath,
    cpuBasis:'API 프로세스 user/system 누적 ms, 코어 하나 100%',bytesBasis:'HTTP 본문 UTF-8 bytes, 헤더·프레이밍 제외',
    background:'반복 타이머와 listen 뒤 귀속·lease 복구 양쪽 중단, 시작 migration 유지, 격리 모의 AionUi',
    timingBasis:'persistMs는 두 버전 모두 요청 문맥의 FS writeFile/rename/rm 경과 합계다. 후보 storageDiagnostics에는 제품의 논리 저장 구간·잠금·외부 대기 시간도 별도 보존한다.',
    limits:{totalMs:30000,multiTotalMs:60000,waitMs:5000,multiWaitMs:10000,perKey:128,total:1024,retryMaximum:3},
    fixture:'96문서×20카드, 원문 문자열·순서 유지, 7댓글 파일×100, Ref 19카드/5원본, 위임 200×결과 1000자, 일정 20카드. 매 round 새 문서 version 1, 20 논리 변경, 조건당 3round',
    retries:'성능 셀은 자동 재시도 없음. 유한 재시도·장애는 별도 회귀 셀.'},sourceFiles:{},fixtures:{},cells:[] }
for(const [variant,root] of Object.entries(roots)) result.sourceFiles[variant]=Object.fromEntries(await Promise.all(['server/index.mjs','server/lib/documentReadStore.mjs','mcp/server.mjs'].map(async file=>[file,hash(await readFile(path.join(root,file)))])))
result.instrumentationFiles=Object.fromEntries(await Promise.all(['scripts/measure-write-cost-07.mjs','tests/helpers/integration-cost-metrics.mjs','tests/helpers/read-cost-metrics.mjs','tests/helpers/read-cost-fixture.mjs','tests/helpers/storage-api-harness.mjs'].map(async file=>[file,hash(await readFile(file))])))
const modes=process.env.MNP_WRITE_SCENARIOS?.split(',')??['comments','review-legacy','content-patch','different-documents','mixed']
const concurrencies=process.env.MNP_MEASURE_CONCURRENCY?.split(',').map(Number)??[1,10,20]
for(const mode of modes) for(const concurrency of concurrencies) {
  const orderIndex=modes.indexOf(mode)*concurrencies.length+concurrencies.indexOf(concurrency)
  for(const variant of orderIndex%2?['candidate','baseline']:['baseline','candidate']) {
    process.env.MNP_STORAGE_TEST_SOURCE_ROOT=roots[variant]
    const after=[]
    let api, currentFixtureHash
    try {
      api=await storageApi({after:fn=>after.push(fn)},{documents:96,readyTimeoutMs:60000,env:{NODE_OPTIONS:`--import=${metrics}`},seed:async args=>{
        await seedReadFixture(args)
        const files={}
        for(const dir of ['','_comments']) for(const file of (await readdir(path.join(args.data,dir))).sort()) {
          if(!dir && !file.startsWith('map-') && file!=='_ai-delegations.json') continue
          const b=await readFile(path.join(args.data,dir,file)); files[path.posix.join(dir,file)]={bytes:b.length,sha256:hash(b)}
        }
        const fixtureHash=hash(JSON.stringify(files));currentFixtureHash=fixtureHash;result.fixtures[fixtureHash]={files,mainChars:JSON.stringify(fixture(args.ids[0])).length,totalBytes:Object.values(files).reduce((n,f)=>n+f.bytes,0)}
      }})
      for(let round=0;round<3;round++) {
        const targets=mode==='different-documents'?api.ids.slice(10+round*20,30+round*20):[api.ids[10+round]]
        const initial={}; for(const id of targets){initial[id]=(await api.call(`/api/maps/${id}`)).body.map;assert.equal(initial[id].version,1)}
        const requests=[], responses=[], auxiliary=[]
        const get=async(route,purpose='혼합 조회')=>{
          const start=performance.now(),r=await fetch(api.base+route,{headers:api.headers,signal:AbortSignal.timeout(60000)}),body=await r.text()
          const row={route,method:'GET',purpose,status:r.status,requestUtf8Bytes:0,responseUtf8Bytes:Buffer.byteLength(body),latencyMs:performance.now()-start};auxiliary.push(row)
          assert.equal(r.status,200,body);return JSON.parse(body)
        }
        await api.readMetrics(true)
        const started=performance.now()
        for(let offset=0;offset<20;offset+=concurrency) {
          const wave=[]
          // 동일 사전 상태를 읽은 한 wave를 양 버전에 그대로 적용한다.
          const maps={};for(const id of (mode==='different-documents'?targets.slice(offset,Math.min(20,offset+concurrency)):targets)) maps[id]=(await get(`/api/maps/${id}`,'조건 준비')).map
          for(let i=offset;i<Math.min(20,offset+concurrency);i++) {
            const mapId=targets[mode==='different-documents'?i:0],before=maps[mapId],cardId=`card-${i}`
            const marker=`07 저장 ${mode}/${concurrency}/${round}/${i}`,id=`mnpw:${Date.now()}:${randomBytes(16).toString('hex')}`
            let route=`/api/maps/${mapId}`,method='PATCH',body,kind,field
            if(mode==='comments'||mode==='mixed'&&i%2===0){route+='/comments';method='POST';kind='comment';body={nodeId:cardId,text:`${mode==='mixed'?'@다른 편집자 ':''}${marker}`}}
            else if(mode==='review-legacy'){route+='/shared-knowledge/reviews';method='POST';kind='field';field='sharedKnowledge';body={baseVersion:before.version,patches:[{cardId,expectedSha256:hash(knowledge),reviewResult:'cleaned',replacement:marker}]}}
            else {route+='/content-patch';kind='field';field='description';const next=structuredClone(before);next.nodes.find(n=>n.id===cardId).data[field]=marker;const patch=createMapContentPatch(before,next);body={baseVersion:before.version,patch,preconditions:createContentPreconditions(before,patch)}}
            const request={id,mapId,cardId,marker,kind,field,route,method,body};requests.push(request)
            wave.push((async()=>{
              const start=performance.now(),text=JSON.stringify(body),r=await fetch(api.base+route,{method,headers:{...api.headers,'Idempotency-Key':id},body:text,signal:AbortSignal.timeout(60000)}),raw=await r.text()
              responses.push({id,route,method,status:r.status,body:JSON.parse(raw),latencyMs:performance.now()-start,requestUtf8Bytes:Buffer.byteLength(text),responseUtf8Bytes:Buffer.byteLength(raw)})
            })())
          }
          if(mode==='mixed') wave.push(...[`/api/maps/${targets[0]}`,`/api/maps/${api.ids[1]}`,'/api/notifications'].map(route=>get(route)))
          await Promise.all(wave)
        }
        const elapsedMs=performance.now()-started,measured=await api.readMetrics()
        const committed=responses.filter(r=>[200,201].includes(r.status)&&r.body.outcome!=='processing')
        const committedIds=committed.map(r=>r.id),expected=requests.filter(q=>committedIds.includes(q.id)).map(q=>q.id),actual=[]
        const maps={},comments={},authority={},history={},backups={}
        const canonicalDir=path.join(out,`canonical-${String(result.cells.length).padStart(3,'0')}`)
        await mkdir(canonicalDir)
        for(const mapId of targets) {
          const raw=await readFile(path.join(api.data,`${mapId}.json`));maps[mapId]=JSON.parse(raw);authority[`${mapId}.json`]={sha256:hash(raw),bytes:raw.length,version:maps[mapId].version}
          await writeFile(path.join(canonicalDir,`${mapId}.json`),raw)
          try{const raw=await readFile(path.join(api.data,'_comments',`${mapId}.json`));comments[mapId]=JSON.parse(raw);authority[`_comments/${mapId}.json`]={sha256:hash(raw),bytes:raw.length,ids:comments[mapId].map(c=>c.id)}}catch(e){if(e.code!=='ENOENT')throw e;comments[mapId]=[]}
          await writeFile(path.join(canonicalDir,`${mapId}.comments.json`),JSON.stringify(comments[mapId]))
          for(const [directory,collection] of [['_history',history],['_daily-backups',backups]]) {
            collection[mapId]=[]
            let files=[];try{files=(await readdir(path.join(api.data,directory,mapId))).filter(f=>f.endsWith('.json'))}catch(e){if(e.code!=='ENOENT')throw e}
            for(const file of files){const raw=await readFile(path.join(api.data,directory,mapId,file)),value=JSON.parse(raw);collection[mapId].push({file,sha256:hash(raw),version:value.map?.version??value.version})}
          }
          const queried=(await api.call(`/api/maps/${mapId}`)).body.map
          for(const q of requests.filter(q=>q.mapId===mapId&&q.kind==='field')) assert.equal(queried.nodes.find(n=>n.id===q.cardId).data[q.field],maps[mapId].nodes.find(n=>n.id===q.cardId).data[q.field])
          const queriedComments=(await api.call(`/api/maps/${mapId}/comments`)).body.comments
          assert.deepEqual(queriedComments.map(c=>({id:c.id,text:c.text})),comments[mapId].map(c=>({id:c.id,text:c.text})))
        }
        for(const q of requests){const present=q.kind==='comment'?comments[q.mapId].some(c=>c.text===q.body.text):maps[q.mapId].nodes.find(n=>n.id===q.cardId).data[q.field]===q.marker;if(present)actual.push(q.id)}
        const expectedNotifications=committed.filter(r=>r.body.comment).length
        const notificationEffects={}
        for(const userId of ['user-admin','user-second']) {
          let notifications=[];try{notifications=await api.read(`_notifications/${userId}.json`)}catch(e){if(e.code!=='ENOENT')throw e}
          const relevant=notifications.filter(n=>Object.values(comments).flat().some(c=>c.id===n.commentId))
          notificationEffects[userId]={expected:expectedNotifications,actual:relevant.length,uniqueComments:new Set(relevant.map(n=>n.commentId)).size,ids:relevant.map(n=>n.id)}
          await writeFile(path.join(canonicalDir,`${userId}.notifications.json`),JSON.stringify(notifications))
        }
        const actualNotifications=notificationEffects['user-second'].actual
        const versions=Object.fromEntries(targets.map(id=>[id,{expected:1+requests.filter(q=>q.mapId===id&&q.kind==='field'&&committedIds.includes(q.id)).length,actual:maps[id].version}]))
        const duplicateComments=requests.filter(q=>q.kind==='comment'&&comments[q.mapId].filter(c=>c.text===q.body.text).length>1).map(q=>q.id)
        const revisionEffects=Object.fromEntries(targets.map(id=>[id,{expected:versions[id].expected-1,actual:history[id].length,uniqueVersions:new Set(history[id].map(h=>h.version)).size}]))
        const journals=[]
        if(variant==='candidate') for(const r of committed) {
          assert.equal(r.body.outcome,'committed');const transactionId=r.body.transactionId
          const intent=await api.read(`_storage-transactions/${transactionId}/intent.json`),applied=await api.read(`_storage-transactions/${transactionId}/applied.json`)
          journals.push({id:r.id,transactionId,intent,applied})
        }
        const integrity=JSON.stringify([...expected].sort())===JSON.stringify([...actual].sort())&&Object.values(versions).every(v=>v.expected===v.actual)&&Object.values(notificationEffects).every(v=>v.expected===v.actual&&v.actual===v.uniqueComments)&&!duplicateComments.length&&Object.values(revisionEffects).every(v=>v.expected===v.actual&&v.actual===v.uniqueVersions)
        const byApi=Object.entries(Object.groupBy([...responses,...auxiliary],r=>`${r.method} ${r.route.replace(/map-bench-\d+/g,':mapId')}`)).map(([api,rows])=>({api,attempts:rows.length,logicalRequests:rows.length,successResponses:rows.filter(r=>[200,201].includes(r.status)).length,requestUtf8Bytes:rows.reduce((n,r)=>n+r.requestUtf8Bytes,0),responseUtf8Bytes:rows.reduce((n,r)=>n+r.responseUtf8Bytes,0),latencyMs:stats(rows.map(r=>r.latencyMs))}))
        const cell={sequence:result.cells.length,mode,category:mode==='mixed'?'혼합':'평상시',concurrency,variant,round,fixtureHash:currentFixtureHash,byApi,httpAttemptsTotal:responses.length+auxiliary.length,
          attempts:responses.length,logicalRequests:requests.length,successResponses:committed.length,committedIds,expectedEffects:expected,actualEffects:actual,expectedNotifications,actualNotifications,notificationEffects,duplicateComments,revisionEffects,history,backups,versions,integrity,
          unresolved:responses.filter(r=>r.body.outcome==='processing'||r.body.outcome==='unknown').map(r=>r.id),retries:0,
          requestUtf8Bytes:responses.reduce((n,r)=>n+r.requestUtf8Bytes,0),responseUtf8Bytes:responses.reduce((n,r)=>n+r.responseUtf8Bytes,0),
          latencyMs:stats(responses.map(r=>r.latencyMs)),elapsedMs,actualEffectsPerSecond:actual.length/(elapsedMs/1000),cpuMsPerActualEffect:actual.length?(measured.cpuUserMs+measured.cpuSystemMs)/actual.length:null,
          metrics:measured,requests,responses,auxiliary,authority,journals}
        result.cells.push(cell)
        await writeFile(path.join(out,`cell-${String(cell.sequence).padStart(3,'0')}.json`),JSON.stringify(cell,null,2))
        await writeFile(path.join(out,'result.json'),JSON.stringify({...result,cells:result.cells.map(({requests:_requests,responses:_responses,journals:_journals,metrics,...rest})=>({...rest,metrics:{...metrics,requests:undefined,storageDiagnostics:undefined},detail:`cell-${String(rest.sequence).padStart(3,'0')}.json`}))},null,2))
        console.log(JSON.stringify({mode,concurrency,variant,round,success:committed.length,preserved:actual.length,integrity,p95:cell.latencyMs.p95}))
      }
      await writeFile(path.join(out,`${mode}-${concurrency}-${variant}.log`),api.output())
    } finally { for(const fn of after.reverse()) await fn() }
  }
}
result.finishedAt=new Date().toISOString()
await writeFile(path.join(out,'finished.json'),JSON.stringify({finishedAt:result.finishedAt,cells:result.cells.length},null,2))
