import {writeFile} from 'node:fs/promises';
import {chromium,firefox,webkit} from '@playwright/test';

// Local synthetic scene only: no WS, backend, or public-canvas mutations.
const options = { url: 'http://127.0.0.1:5173', strokes: 200, output: undefined };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const option = args[i];
  if (option === '--help') {
    console.log('Usage: node scripts/bench-occlusion.mjs [--strokes 200] [--url http://127.0.0.1:5173] [--output result.json]');
    process.exit(0);
  }
  if (!['--strokes', '--url', '--output'].includes(option) || args[i + 1] === undefined) {
    throw new Error('Unknown option or missing value: ' + option);
  }
  const value = args[++i];
  if (option === '--strokes') options.strokes = Number(value);
  else if (option === '--url') options.url = value;
  else options.output = value;
}
if (!Number.isInteger(options.strokes) || options.strokes < 1 || options.strokes > 2000) {
  throw new Error('--strokes must be an integer between 1 and 2000');
}
const base = new URL(options.url);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.search || base.hash) {
  throw new Error('Use an explicit local http://127.0.0.1 Vite origin');
}
const results=[];
for(const [browserName,engine] of Object.entries({chromium,firefox,webkit})){
 const browser=await engine.launch();
 for(const dpr of [1,2]){
  const context=await browser.newContext({viewport:{width:1000,height:700},deviceScaleFactor:dpr});
  const page=await context.newPage();await page.goto(new URL('/about/',base).href);
  const row=await page.evaluate(async(hiddenCount)=>{
   const {createSceneRenderer}=await import('/src/scene-renderer.ts');
   document.body.style.cssText='margin:0;padding:0';
   const run=async(hidden)=>{
    const canvas=document.createElement('canvas');canvas.style.width='1000px';canvas.style.height='700px';document.body.append(canvas);
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:true});
    let fbo=null;const counts={screen:0,offscreen:0,staticUploads:0};
    const bind=gl.bindFramebuffer.bind(gl);gl.bindFramebuffer=(target,value)=>{fbo=value;return bind(target,value);};
    for(const name of ['drawArrays','drawArraysInstanced']){const draw=gl[name].bind(gl);gl[name]=(...args)=>{if(fbo===null)counts.screen++;else counts.offscreen++;return draw(...args);};}
    const upload=gl.bufferData.bind(gl);gl.bufferData=(...args)=>{if(args[2]===gl.STATIC_DRAW)counts.staticUploads++;return upload(...args);};
    const strokes=Array.from({length:hidden+1},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,seq:i+1,own:false,
      brush:'round',width:i===hidden?64:16,color:i===hidden?'#202020':'#E46C60',opacity:1,
      points:Object.freeze(i===hidden?[[-80,0],[80,0]]:[[-50,0],[50,0]])}));
    let last=performance.now(),frames=0,resolvePaint;
    const renderer=createSceneRenderer(canvas,{camera:()=>({x:0,y:0,zoom:1}),viewport:()=>({width:1000,height:700}),
      scene:{strokes:()=>strokes,hidden:new Set()},overlays:()=>[],painted:()=>{last=performance.now();frames++;resolvePaint?.();resolvePaint=undefined;}});
    const started=performance.now();for(const stroke of strokes)renderer.added(stroke);const prepareMs=performance.now()-started;
    renderer.resize({width:1000,height:700},devicePixelRatio);
    const start=performance.now();
    do{await new Promise(requestAnimationFrame);if(performance.now()-start>15000)throw new Error('Not idle');}while(performance.now()-last<260);
    const cold={...counts};
    const before=counts.offscreen;const next=new Promise(resolve=>{resolvePaint=resolve;});renderer.invalidate();await next;
    const warmOffscreen=counts.offscreen-before;
    const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');
    renderer.dispose();canvas.remove();
    return {hidden_strokes:hidden,cold_offscreen_draws:cold.offscreen,static_buffer_uploads:cold.staticUploads,geometry_prepare_cpu_ms:prepareMs,warm_offscreen_draws:warmOffscreen,rgba_hash:hash,frames};
   };
   const visibleOnly=await run(0);const occluded=await run(hiddenCount);
   return {visible_only:visibleOnly,occluded,pixels_equal:visibleOnly.rgba_hash===occluded.rgba_hash};
  }, options.strokes);
  if (!row.pixels_equal) throw new Error('Occluded geometry changed the final pixels');
  const result={browser:browserName,dpr,...row};results.push(result);console.log(JSON.stringify(result));await context.close();
 }
 await browser.close();
}
if (options.output) await writeFile(options.output,JSON.stringify({ schema: 1, hidden_strokes: options.strokes, viewport: { width: 1000, height: 700 }, results },null,2)+'\n',{flag:'wx'});
