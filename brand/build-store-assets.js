'use strict';

/**
 * Generates the Google Play listing graphics from the same source of truth as
 * every other brand asset.
 *
 * Play asks for three kinds of image, and they are not interchangeable:
 *
 *   icon           512x512, already produced by build-logo.js as icon-512.png.
 *                  Nothing to do here; listed so the checklist is complete.
 *   feature graphic 1024x500, drawn below. Shown at the top of the listing and
 *                  in promotional placements, where Play may letterbox it,
 *                  darken it, or stamp a play button across the middle - which
 *                  is why the artwork keeps its text out of the centre band and
 *                  well inside the edges.
 *   screenshots    at least two, 16:9 or 9:16, between 320 and 3840px a side.
 *                  Composited from real captures; see below.
 *
 * On screenshots, and why this script will not invent them: Play requires a
 * screenshot to show the app as it actually runs. A rendered mock-up of the UI
 * would be both a policy problem and a promise the app has to keep. So the
 * captures are yours - drop PNGs into brand/screens/ - and this only supplies
 * the frame around them: the brand ground, a caption, and a device bezel.
 *
 * Run: node brand/build-store-assets.js
 */

const fs = require('node:fs');
const path = require('node:path');

// Same two-location resolution as build-logo.js: the repo root has no
// node_modules, the API's tree declares sharp.
const sharp = (() => {
  try {
    return require('sharp');
  } catch {
    return require(path.join(__dirname, '..', 'TOY-backend', 'node_modules', 'sharp'));
  }
})();

const { STROKE, VIEW, inkPath, goldPath } = require('./geometry');

const OUT = path.join(__dirname, 'store');
const SCREENS = path.join(__dirname, 'screens');

// Sampled from the reference artwork, as in build-logo.js. Duplicated rather
// than exported from there because that script's constants are private to it;
// if they ever diverge, geometry.js is the file that decides.
const GOLD = ['#FFD64F', '#F9B417', '#EF8F00'];
const INK = ['#3B3B3E', '#232326', '#151517'];
const CREAM = '#FBEDC8';
const CROSS = { x: 225, y: 0, width: 110, height: 123 };

/** librsvg resolves these against the system; Inter is the product's face. */
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const gradients = `
    <linearGradient id="oo-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${GOLD[0]}"/>
      <stop offset="0.5" stop-color="${GOLD[1]}"/>
      <stop offset="1" stop-color="${GOLD[2]}"/>
    </linearGradient>
    <linearGradient id="oo-ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${INK[0]}"/>
      <stop offset="0.55" stop-color="${INK[1]}"/>
      <stop offset="1" stop-color="${INK[2]}"/>
    </linearGradient>
    <clipPath id="oo-cross">
      <rect x="${CROSS.x}" y="${CROSS.y}" width="${CROSS.width}" height="${CROSS.height}"/>
    </clipPath>`;

/** The interlocking rings, in their own 560x320 coordinate space. */
const rings = `
  <g fill="none" stroke-width="${STROKE}" stroke-linecap="butt">
    <path d="${inkPath}" stroke="url(#oo-ink)"/>
    <path d="${goldPath}" stroke="url(#oo-gold)"/>
    <g clip-path="url(#oo-cross)">
      <path d="${inkPath}" stroke="url(#oo-ink)"/>
    </g>
  </g>`;

/**
 * The rings without the interlock re-draw, for decoration only.
 *
 * The interlock works by stamping the ink ring a second time inside a
 * rectangular clip. At full opacity that is invisible, because it lands exactly
 * on the ink ring already there. Behind a low group opacity it is not: the
 * clip's straight edge becomes a faint rectangle ruled across the artwork,
 * which at 16% is the only thing on that side of the graphic with a hard
 * corner, so it is the first thing the eye finds.
 */
const ringsDecor = `
  <g fill="none" stroke-width="${STROKE}" stroke-linecap="butt">
    <path d="${inkPath}" stroke="url(#oo-ink)"/>
    <path d="${goldPath}" stroke="url(#oo-gold)"/>
  </g>`;

/**
 * The mark placed on a larger canvas.
 *
 * A nested <svg> rather than a transform: it re-establishes the viewBox, so the
 * ring paths keep the proportions geometry.js measured off the reference
 * instead of inheriting the parent's aspect ratio and shearing.
 */
const markAt = (x, y, width) => {
  const height = (width * VIEW.height) / VIEW.width;
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${VIEW.width} ${VIEW.height}">${rings}</svg>`;
};

const render = (svg, out, width, height) =>
  sharp(Buffer.from(svg), { density: 400 })
    .resize({ width, height })
    .png()
    .toFile(out);

// ---------------------------------------------------------------------------
// Feature graphic - 1024x500
// ---------------------------------------------------------------------------

const FEATURE = { w: 1024, h: 500 };

/**
 * One low-contrast mark, placed so it bleeds off the right edge.
 *
 * Decoration that reads as texture at a glance and as the mark on a second
 * look, and - being behind the safe area rather than in it - survives Play
 * cropping the graphic without taking any words with it.
 *
 * The placement is not free-hand. The ink ring has to land entirely on the
 * canvas and the gold one has to run off it: a mark positioned so that *both*
 * rings are mostly past the edge leaves two short, thick stroke stubs, and a
 * 36-wide stroke cut square at both ends reads as a rectangle rather than as
 * part of a circle. Whole ring first, bleeding ring second.
 */
const featureDecor = `
  <g opacity="0.17">
    <svg x="618" y="54" width="560" height="320" viewBox="0 0 ${VIEW.width} ${VIEW.height}">${ringsDecor}</svg>
  </g>`;

const featureGraphic = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FEATURE.w} ${FEATURE.h}">
  <defs>${gradients}
    <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFF8E4"/>
      <stop offset="0.55" stop-color="${CREAM}"/>
      <stop offset="1" stop-color="#F3DCA8"/>
    </linearGradient>
  </defs>

  <rect width="${FEATURE.w}" height="${FEATURE.h}" fill="url(#ground)"/>
  ${featureDecor}

  <!-- Text block kept inside x=[72, 620]: clear of the centre where Play
       stamps a play button, and far enough from the edges to survive a crop. -->
  ${markAt(64, 92, 190)}

  <text x="72" y="286" font-family="${FONT}" font-size="76" font-weight="800"
        fill="${INK[2]}" letter-spacing="-2">OffersOffer</text>

  <text x="74" y="342" font-family="${FONT}" font-size="30" font-weight="500"
        fill="#6B5B33">Real offers from shops near you</text>

  <g transform="translate(74, 382)">
    <rect width="250" height="52" rx="26" fill="${INK[2]}"/>
    <text x="125" y="34" font-family="${FONT}" font-size="22" font-weight="600"
          fill="${GOLD[0]}" text-anchor="middle">Claim in seconds</text>
  </g>
</svg>
`;

// ---------------------------------------------------------------------------
// Screenshots - 1080x1920, composited around a real capture
// ---------------------------------------------------------------------------

const SHOT = { w: 1080, h: 1920 };

/**
 * The captions, in the order Play shows them.
 *
 * The first screenshot is the only one most visitors see, so it carries the
 * plainest promise rather than the cleverest line. Each file is matched by
 * position: screens/1.png gets CAPTIONS[0], and a missing file is skipped with
 * a warning rather than failing the run, so a partial set still builds.
 */
const CAPTIONS = [
  ['Offers near you', 'Real discounts from shops in your city'],
  ['Claim in seconds', 'Show the QR code in store — that is it'],
  ['Find what is close', 'Browse by category or by how far you will walk'],
  ['Never miss one', 'Follow your shops and get told when they post'],
];

/** The frame: brand ground, caption above, a bezelled capture below. */
const shotFrame = (heading, sub, deviceBox) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHOT.w} ${SHOT.h}">
  <defs>${gradients}
    <linearGradient id="ground" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#FFF8E4"/>
      <stop offset="0.6" stop-color="${CREAM}"/>
      <stop offset="1" stop-color="#F0D69C"/>
    </linearGradient>
    <filter id="lift" x="-20%" y="-10%" width="140%" height="130%">
      <feDropShadow dx="0" dy="18" stdDeviation="26" flood-color="#6B5117" flood-opacity="0.30"/>
    </filter>
  </defs>

  <rect width="${SHOT.w}" height="${SHOT.h}" fill="url(#ground)"/>
  <g opacity="0.12">
    <svg x="548" y="1516" width="560" height="320" viewBox="0 0 ${VIEW.width} ${VIEW.height}">${ringsDecor}</svg>
  </g>

  ${markAt(74, 86, 128)}

  <text x="74" y="330" font-family="${FONT}" font-size="72" font-weight="800"
        fill="${INK[2]}" letter-spacing="-1.5">${heading}</text>
  <text x="76" y="392" font-family="${FONT}" font-size="34" font-weight="500"
        fill="#6B5B33">${sub}</text>

  <!-- The bezel only. The capture itself is composited over it by sharp, so
       nothing here can misrepresent what the app shows. -->
  <g filter="url(#lift)">
    <rect x="${deviceBox.x - 14}" y="${deviceBox.y - 14}"
          width="${deviceBox.width + 28}" height="${deviceBox.height + 28}"
          rx="52" fill="${INK[2]}"/>
  </g>
</svg>
`;

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  await render(featureGraphic, path.join(OUT, 'feature-graphic.png'), FEATURE.w, FEATURE.h);
  console.log('  feature-graphic.png  1024x500');

  // The store icon is build-logo.js's output, copied so everything Play needs
  // sits in one folder to upload from. Only the root working copy has the PNGs,
  // so its absence means this is the TOY-backend copy running - not an error.
  const icon = path.join(__dirname, 'icon-512.png');
  if (fs.existsSync(icon)) {
    fs.copyFileSync(icon, path.join(OUT, 'icon-512.png'));
    console.log('  icon-512.png         512x512  (from build-logo.js)');
  } else {
    console.log('  icon-512.png         skipped - run build-logo.js first');
  }

  // Mirrored into TOY-backend/brand/ the way build-logo.js mirrors itself: the
  // repo root is not a git repository, so a generator left only there is the
  // one part of the brand system nothing is keeping.
  const tracked = path.join(__dirname, '..', 'TOY-backend', 'brand');
  if (fs.existsSync(tracked)) {
    fs.copyFileSync(__filename, path.join(tracked, path.basename(__filename)));
  }

  if (!fs.existsSync(SCREENS)) {
    fs.mkdirSync(SCREENS, { recursive: true });
  }

  let built = 0;
  for (let i = 0; i < CAPTIONS.length; i += 1) {
    const source = path.join(SCREENS, `${i + 1}.png`);
    if (!fs.existsSync(source)) continue;

    const [heading, sub] = CAPTIONS[i];

    // The capture keeps its own aspect ratio inside a fixed width, so a 19.5:9
    // phone and a 16:9 one both sit correctly rather than being stretched to
    // whatever the frame assumed.
    const meta = await sharp(source).metadata();
    const width = 820;
    const height = Math.round((width * meta.height) / meta.width);
    const box = { x: Math.round((SHOT.w - width) / 2), y: 500, width, height };

    const frame = await sharp(Buffer.from(shotFrame(heading, sub, box)), { density: 400 })
      .resize({ width: SHOT.w, height: SHOT.h })
      .png()
      .toBuffer();

    const capture = await sharp(source)
      .resize({ width, height })
      .composite([
        {
          // Rounded corners, so the capture sits in the bezel instead of on it.
          input: Buffer.from(
            `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="38" fill="#fff"/></svg>`,
          ),
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer();

    const out = path.join(OUT, `screenshot-${i + 1}.png`);
    await sharp(frame).composite([{ input: capture, left: box.x, top: box.y }]).png().toFile(out);
    console.log(`  screenshot-${i + 1}.png       ${SHOT.w}x${SHOT.h}  "${heading}"`);
    built += 1;
  }

  if (built < 2) {
    console.log(
      `\n  ${built} screenshot(s) built. Play requires at least 2.\n` +
        `  Put phone captures at brand/screens/1.png ... ${CAPTIONS.length}.png and re-run.\n` +
        `  Captions are in CAPTIONS at the top of this file.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
