// Regenerate with: node tests/browser/host-markdown-generate.mjs /path/to/dsh-repo
// Executes the host's real parser, incremental parser and React renderer.
// CSS modules use deterministic fixture class names; this is not a live host app.
import { createRequire, register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const host = resolve(process.argv[2] || (() => { throw Error('Pass the DSH source checkout path') })())
const hostRequire = createRequire(join(host, 'package.json'))
const uiRoot = join(host, 'packages/client/ui-primitives')
const uiRequire = createRequire(join(uiRoot, 'package.json'))
const { register: registerTsx } = await import(pathToFileURL(hostRequire.resolve('tsx/esm/api')).href)
registerTsx()
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url,context,nextLoad){
 if(url.endsWith('.css'))return {format:'module',shortCircuit:true,source:'export default new Proxy({}, {get:(_,key)=>"host_"+String(key)+"_fixture"})'};
 return nextLoad(url,context)
}`), import.meta.url)
const moduleUrl = name => pathToFileURL(join(uiRoot, 'src/markdown', name)).href
const { parseGfm, parseGfmWithMath } = await import(moduleUrl('parse.ts'))
const { IncrementalMarkdownParser } = await import(moduleUrl('incremental.ts'))
const { renderBlocks, createReferenceTargets, collectReferenceTargets, wrapBlockChildren } = await import(moduleUrl('render.tsx'))
// tsx resolves this standalone script outside the host tsconfig; supply the
// classic JSX binding with the host's own React instance.
const React = await import(pathToFileURL(uiRequire.resolve('react')).href)
globalThis.React = React
const { createElement, Fragment } = React
const { renderToStaticMarkup } = await import(pathToFileURL(uiRequire.resolve('react-dom/server')).href)
const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Sources' }
function render(blocks, streaming) {
 const targets = createReferenceTargets()
 collectReferenceTargets(blocks.map(b => b.node), targets)
 return renderToStaticMarkup(createElement(Fragment, null, ...wrapBlockChildren(renderBlocks(blocks, {
  streaming, labels, targets, footnoteOrder: [], footnoteCounts: new Map(), omitHtml: false,
  fileMentions: undefined, pathImages: undefined,
 }), false)))
}
const url = 'https://apnews.com/article/nvidia-jensen-huang-colette-kress-39ea208c0-long-reference'
const cases = [
 {id:'citation',prefix:'- **来源核对**：这段说明需要等待前文完成。（',tail:`[AP](${url})）。`,kind:'citation'},
 {id:'formatted-label',prefix:'来源：',tail:`[**AP**](${url})。`,kind:'citation'},
 {id:'bare-url',prefix:'原始网址：',tail:url,kind:'ordinary'},
 {id:'malformed-final',prefix:'未闭合引用：',tail:`[AP](${url}`,kind:'malformed'},
 {id:'escaped-label',prefix:'转义示例：',tail:`\\[AP](${url})`,kind:'ordinary'},
 {id:'inline-code',prefix:'代码示例：',tail:'`[AP]('+url+')`',kind:'code'},
 {id:'balanced-destination',prefix:'参考：',tail:'[AP](https://example.com/report_(2026)/details)。',kind:'citation'},
 {id:'consecutive-links',prefix:'参考资料：',tail:`[AP](${url}) 与 [来源](https://example.com/source)。`,kind:'citation'},
 {id:'icon-after-prose',prefix:'',tail:'需纠正一处：几个每日更新的播报栏目，需要核对原始来源。[来源](https://example.com/source)',kind:'icon'},
]
const schedules = { fine:[1,2,1,4,3,8], burst:[7,19,3,31], boundaries:null }
const outputCases=[]
for(const item of cases)for(const [schedule,sizes] of Object.entries(schedules)){
 const chunks=[item.prefix];let pos=0,index=0
 if(sizes){while(pos<item.tail.length){const end=Math.min(item.tail.length,pos+sizes[index++%sizes.length]);chunks.push(item.tail.slice(pos,end));pos=end}}
 else {const boundaries=[0,item.tail.indexOf('](')+2,item.tail.indexOf('https:')+6,item.tail.indexOf('https:')+8,item.tail.indexOf('.com')+4,item.tail.lastIndexOf(')'),item.tail.length].filter(n=>n>0&&n<=item.tail.length);for(const end of [...new Set(boundaries)].sort((a,b)=>a-b)){if(end>pos){chunks.push(item.tail.slice(pos,end));pos=end}}}
 const parser=new IncrementalMarkdownParser(parseGfm);let accumulatedSource='';const frames=[]
 for(const chunk of chunks){accumulatedSource+=chunk;const parsed=parser.update(accumulatedSource);const blocks=[...parsed.frozen,...parsed.tail];frames.push({chunk,accumulatedSource,streaming:true,html:render(blocks,true),ast:blocks.map(b=>b.node)})}
 const settled=parseGfmWithMath(accumulatedSource)
 frames.push({chunk:'',accumulatedSource,streaming:false,html:render(settled.children.map((node,key)=>({node,key})),false),ast:settled.children})
 outputCases.push({id:item.id+'-'+schedule,kind:item.kind,schedule,source:accumulatedSource,frames})
}
const sourceFiles=['parse.ts','incremental.ts','render.tsx','MarkdownText.tsx','MarkdownText.module.css','cjkFriendlyStrong.ts','windows-path-destinations.ts','local-image-syntax.ts','mathCompatibility.ts'].map(n=>'packages/client/ui-primitives/src/markdown/'+n)
sourceFiles.push('packages/client/ui-primitives/src/LinkIcon.tsx','packages/client/ui-primitives/src/icons/shared-artwork.tsx')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const files=await Promise.all(sourceFiles.map(async path=>({path,sha256:sha(await readFile(join(host,path)))})))
const dependencies=[]
for(const name of ['mdast-util-from-markdown','mdast-util-gfm','micromark-extension-gfm','react','react-dom']){
 const entry=uiRequire.resolve(name);let dir=dirname(entry),pkg
 while(!pkg){try{const candidate=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(candidate.name===name)pkg=candidate}catch{}const parent=dirname(dir);if(!pkg&&parent===dir)throw Error('Package metadata missing: '+name);if(!pkg)dir=parent}
 dependencies.push({name,version:pkg.version,entrySha256:sha(await readFile(entry))})
}
const out={schemaVersion:1,provenance:{hostVersion:JSON.parse(await readFile(join(host,'package.json'),'utf8')).version,rendererMode:'actual-incremental-parser-and-react-ssr',limitations:['CSS module names substituted with deterministic fixture names','SSR snapshots remounted by browser harness; not React reconciliation or authenticated app','Input is synthetic, not recorded model token traffic'],hostSourceFiles:files,dependencies},cases:outputCases}
const destination=join(dirname(fileURLToPath(import.meta.url)),'host-markdown-snapshots.json')
await writeFile(destination,JSON.stringify(out)+'\n')
console.log(JSON.stringify({destination,cases:outputCases.length,frames:outputCases.reduce((n,c)=>n+c.frames.length,0),rendererMode:out.provenance.rendererMode}))
