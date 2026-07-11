import fs from 'node:fs/promises';

export const DEFAULT_VISUAL_THRESHOLD = 0.62;

export function scorePixelSamples(reference, actual) {
  if (reference.length !== actual.length || reference.length % 4 !== 0) {
    throw new Error('visual samples must have equal RGBA lengths');
  }
  const refGray = [];
  const actualGray = [];
  const refHist = Array(12).fill(0);
  const actualHist = Array(12).fill(0);
  for (let offset = 0; offset < reference.length; offset += 4) {
    refGray.push(gray(reference[offset], reference[offset + 1], reference[offset + 2]));
    actualGray.push(gray(actual[offset], actual[offset + 1], actual[offset + 2]));
    addHistogram(refHist, reference, offset);
    addHistogram(actualHist, actual, offset);
  }
  const structure = clamp(ssim(refGray, actualGray));
  const color = clamp(
    1 - refHist.reduce(
      (sum, value, index) => sum + Math.abs(value - actualHist[index]),
      0,
    ) / (6 * refGray.length),
  );
  return {
    structure: round(structure),
    color: round(color),
    score: round(structure * 0.7 + color * 0.3),
  };
}

export async function compareImageFiles(
  page,
  { referenceFile, actualFile, sampleSize = 96 },
) {
  const [referenceBytes, actualBytes] = await Promise.all([
    fs.readFile(referenceFile),
    fs.readFile(actualFile),
  ]);
  const samples = await page.evaluate(async ({ referenceUrl, actualUrl, size }) => {
    const load = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
    const sample = async (src) => {
      const image = await load(src);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, size, size);
      return Array.from(context.getImageData(0, 0, size, size).data);
    };
    return {
      reference: await sample(referenceUrl),
      actual: await sample(actualUrl),
    };
  }, {
    referenceUrl: `data:image/${referenceMimeSubtype(referenceFile)};base64,${referenceBytes.toString('base64')}`,
    actualUrl: `data:image/png;base64,${actualBytes.toString('base64')}`,
    size: sampleSize,
  });
  return scorePixelSamples(
    Uint8Array.from(samples.reference),
    Uint8Array.from(samples.actual),
  );
}

function referenceMimeSubtype(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.webp')) return 'webp';
  return 'jpeg';
}

function gray(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function addHistogram(histogram, pixels, offset) {
  histogram[Math.floor(pixels[offset] / 64)] += 1;
  histogram[4 + Math.floor(pixels[offset + 1] / 64)] += 1;
  histogram[8 + Math.floor(pixels[offset + 2] / 64)] += 1;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ssim(reference, actual) {
  const referenceMean = mean(reference);
  const actualMean = mean(actual);
  let referenceVariance = 0;
  let actualVariance = 0;
  let covariance = 0;
  for (let index = 0; index < reference.length; index += 1) {
    referenceVariance += (reference[index] - referenceMean) ** 2;
    actualVariance += (actual[index] - actualMean) ** 2;
    covariance += (reference[index] - referenceMean) * (actual[index] - actualMean);
  }
  const divisor = Math.max(reference.length - 1, 1);
  referenceVariance /= divisor;
  actualVariance /= divisor;
  covariance /= divisor;
  const c1 = 6.5025;
  const c2 = 58.5225;
  return (
    ((2 * referenceMean * actualMean + c1) * (2 * covariance + c2))
    / (
      (referenceMean ** 2 + actualMean ** 2 + c1)
      * (referenceVariance + actualVariance + c2)
    )
  );
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
