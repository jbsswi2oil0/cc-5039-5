import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
const r = await p.evaluate(() => {
  const v = document.createElement('video');
  const types = [
    'video/mp4; codecs="avc1.42E01E"',
    'video/webm; codecs="vp8"',
    'video/webm; codecs="vp9"',
    'video/mp4; codecs="vp09.00.10.08"',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/webm; codecs="opus"',
  ];
  const mse = types.map(t => [t, typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t)]);
  return { canPlay: types.map(t => [t, v.canPlayType(t)]), mse, ua: navigator.userAgent };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
