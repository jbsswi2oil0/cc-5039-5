// Parser for the local live media playlist. The parser deliberately returns
// the three clocks as separate fields: media sequence numbers, segment
// durations, and source-declared dates (EXT-X-PROGRAM-DATE-TIME). It does not
// build a timeline; that is the kernel's job.

export class ManifestError extends Error {
  constructor(message, lineNumber = null, line = null) {
    super(lineNumber == null ? message : `${message} (line ${lineNumber}: ${line})`);
    this.name = 'ManifestError';
    this.lineNumber = lineNumber;
    this.line = line;
  }
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_SCHEMES = new Set(['http:', 'https:']);

function fail(message, lineNumber, line) {
  throw new ManifestError(message, lineNumber, line);
}

function parseInteger(raw, tag, lineNumber, line) {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) fail(`invalid integer for ${tag}`, lineNumber, line);
  return Number(text);
}

function parseDuration(raw, lineNumber, line) {
  const text = raw.split(',')[0].trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) fail('invalid EXTINF duration', lineNumber, line);
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    fail('EXTINF duration must be greater than zero', lineNumber, line);
  }
  return value;
}

function parseDate(raw, tag, lineNumber, line, issues) {
  const text = raw.trim();
  if (!ISO_DATE.test(text)) {
    issues.push({ code: 'invalid-date', tag, value: text, lineNumber });
    return null;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    issues.push({ code: 'invalid-date', tag, value: text, lineNumber });
    return null;
  }
  return { ms, text };
}

function parseAttributeList(raw, lineNumber, line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[match[1]] = value;
  }
  if (Object.keys(attrs).length === 0 && raw.trim()) {
    fail('invalid attribute list', lineNumber, line);
  }
  return attrs;
}

function validateUri(uri, lineNumber, line) {
  if (!uri || /[\u0000-\u001f\u007f\s]/.test(uri)) {
    fail('invalid segment URI', lineNumber, line);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) {
    let url;
    try {
      url = new URL(uri);
    } catch {
      fail('unparseable absolute segment URI', lineNumber, line);
    }
    if (!SAFE_SCHEMES.has(url.protocol)) {
      fail(`unsupported segment URI scheme ${url.protocol}`, lineNumber, line);
    }
  }
}

export function parseMediaPlaylist(text, { sourceUrl = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('playlist text must be a string');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const issues = [];
  const unknownTags = new Set();
  const segments = [];

  let sawHeader = false;
  let targetDuration = null;
  let mediaSequence = null;
  let discontinuitySequenceBase = null;
  let version = null;
  let playlistType = null;
  let ended = false;
  let map = null;
  let frameRate = null;

  let pendingInf = null;
  let pendingDiscontinuity = false;
  let pendingDate = null;
  let pendingGap = false;
  let pendingFrameIndex = null;

  let lineNumber = 0;
  for (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;

    if (!sawHeader) {
      if (line !== '#EXTM3U') fail('playlist must start with #EXTM3U', lineNumber, line);
      sawHeader = true;
      continue;
    }

    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        if (pendingInf != null) fail('two EXTINF tags before a segment URI', lineNumber, line);
        pendingInf = {
          durationSec: parseDuration(line.slice('#EXTINF:'.length), lineNumber, line),
          lineNumber,
        };
        continue;
      }
      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseInteger(
          line.slice('#EXT-X-TARGETDURATION:'.length),
          'EXT-X-TARGETDURATION',
          lineNumber,
          line,
        );
        if (targetDuration <= 0) fail('EXT-X-TARGETDURATION must be positive', lineNumber, line);
        continue;
      }
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInteger(
          line.slice('#EXT-X-MEDIA-SEQUENCE:'.length),
          'EXT-X-MEDIA-SEQUENCE',
          lineNumber,
          line,
        );
        if (mediaSequence < 0) fail('EXT-X-MEDIA-SEQUENCE must be non-negative', lineNumber, line);
        continue;
      }
      if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        discontinuitySequenceBase = parseInteger(
          line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length),
          'EXT-X-DISCONTINUITY-SEQUENCE',
          lineNumber,
          line,
        );
        if (discontinuitySequenceBase < 0) {
          fail('EXT-X-DISCONTINUITY-SEQUENCE must be non-negative', lineNumber, line);
        }
        continue;
      }
      if (line.startsWith('#EXT-X-VERSION:')) {
        version = parseInteger(line.slice('#EXT-X-VERSION:'.length), 'EXT-X-VERSION', lineNumber, line);
        continue;
      }
      if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
        continue;
      }
      if (line.startsWith('#EXT-X-FRAME-RATE:')) {
        const value = Number(line.slice('#EXT-X-FRAME-RATE:'.length).trim());
        if (!Number.isFinite(value) || value <= 0) {
          fail('invalid EXT-X-FRAME-RATE', lineNumber, line);
        }
        frameRate = value;
        continue;
      }
      if (line === '#EXT-X-DISCONTINUITY') {
        pendingDiscontinuity = true;
        continue;
      }
      if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        const parsed = parseDate(
          line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length),
          'EXT-X-PROGRAM-DATE-TIME',
          lineNumber,
          line,
          issues,
        );
        if (parsed) pendingDate = parsed;
        continue;
      }
      if (line === '#EXT-X-GAP') {
        pendingGap = true;
        continue;
      }
      if (line.startsWith('#EXT-X-FRAME-INDEX:')) {
        pendingFrameIndex = parseInteger(
          line.slice('#EXT-X-FRAME-INDEX:'.length),
          'EXT-X-FRAME-INDEX',
          lineNumber,
          line,
        );
        if (pendingFrameIndex < 0) fail('EXT-X-FRAME-INDEX must be non-negative', lineNumber, line);
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length), lineNumber, line);
        if (!attrs.URI) fail('EXT-X-MAP requires URI', lineNumber, line);
        validateUri(attrs.URI, lineNumber, line);
        map = { uri: attrs.URI, byterange: attrs.BYTERANGE ?? null };
        continue;
      }
      if (line === '#EXT-X-ENDLIST') {
        ended = true;
        continue;
      }
      if (line === '#EXT-X-INDEPENDENT-SEGMENTS') continue;
      if (line === '#EXT-X-I-FRAMES-ONLY') continue;
      if (line === '#EXT-X-DISCONTINUITY-SEQUENCE') continue;
      if (line.startsWith('#EXT-X-')) {
        unknownTags.add(line.slice(0, line.indexOf(':') === -1 ? line.length : line.indexOf(':')));
        continue;
      }
      // Other comments are permitted.
      continue;
    }

    if (!pendingInf) fail('segment URI without a preceding EXTINF', lineNumber, line);
    validateUri(line, lineNumber, line);
    const msn = (mediaSequence ?? 0) + segments.length;
    const durationMs = Math.round(pendingInf.durationSec * 1000);
    segments.push({
      msn,
      uri: line,
      durationMs,
      durationSec: pendingInf.durationSec,
      discontinuityBefore: pendingDiscontinuity,
      programDateTimeMs: pendingDate ? pendingDate.ms : null,
      programDateTimeText: pendingDate ? pendingDate.text : null,
      gap: pendingGap,
      frameIndex: pendingFrameIndex,
      lineNumber,
    });
    pendingInf = null;
    pendingDiscontinuity = false;
    pendingDate = null;
    pendingGap = false;
    pendingFrameIndex = null;
  }

  if (!sawHeader) fail('empty playlist: missing #EXTM3U');
  if (pendingInf != null) {
    fail('trailing EXTINF without a segment URI', pendingInf.lineNumber);
  }
  if (segments.length === 0) fail('playlist contains no segments');
  if (mediaSequence == null) {
    issues.push({ code: 'missing-media-sequence' });
    mediaSequence = segments[0].msn;
  }
  if (targetDuration == null) issues.push({ code: 'missing-target-duration' });

  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].msn <= segments[i - 1].msn) {
      issues.push({
        code: 'non-increasing-media-sequence',
        previous: segments[i - 1].msn,
        value: segments[i].msn,
      });
      throw new ManifestError(
        `media sequence is not strictly increasing (${segments[i - 1].msn} -> ${segments[i].msn})`,
        segments[i].lineNumber,
        segments[i].uri,
      );
    }
    const step = segments[i].msn - segments[i - 1].msn;
    if (step > 1) {
      issues.push({
        code: 'media-sequence-gap',
        afterMsn: segments[i - 1].msn,
        missing: step - 1,
      });
    }
  }

  return {
    sourceUrl,
    version,
    targetDuration,
    mediaSequence,
    discontinuitySequenceBase,
    playlistType,
    ended,
    frameRate,
    map,
    issues,
    unknownTags: [...unknownTags],
    segments,
  };
}
