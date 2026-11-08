// Headless Chromium on the GPU when there is one, SwiftShader (CPU) only as a fallback.
// const {browser, renderer} = await launchGPU(chromium)
// ANGLE=d3d11 / gl / vulkan / swiftshader forces one backend. The renderer string of a WebGL2 context decides:
// SwiftShader (or no WebGL) on a GPU backend means no usable GPU, and the browser is started again on SwiftShader.
// RTX 4070: 1170 frames of vrecord.mjs at 1280x720 in about 1 minute on d3d11; SwiftShader took about 4 s a frame.
const CPU = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const GPU = angle => [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'];

async function rendererOf(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      if (!g) return '';
      const e = g.getExtension('WEBGL_debug_renderer_info');
      return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
    });
  } finally { await page.close(); }
}

export async function launchGPU(chromium) {
  const forced = process.env.ANGLE;
  const tries = forced ? [forced] : [process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'vulkan', 'gl'];
  for (const angle of tries) {
    if (angle === 'swiftshader') break;
    let browser;
    try {
      browser = await chromium.launch({args: GPU(angle)});
      const renderer = await rendererOf(browser);
      if (renderer && !/swiftshader|llvmpipe|software/i.test(renderer)) {
        console.log('renderer (GPU)', renderer); return {browser, renderer};
      }
      console.log(`renderer on ${angle} is "${renderer}": no GPU there`);
    } catch (e) { console.log(`GPU launch on ${angle} failed:`, e.message.split('\n')[0]); }
    await browser?.close();
  }
  const browser = await chromium.launch({args: CPU}), renderer = await rendererOf(browser);
  console.log('renderer (CPU fallback)', renderer); return {browser, renderer};
}
