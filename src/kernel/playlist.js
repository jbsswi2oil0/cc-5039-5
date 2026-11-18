// Parser for media playlists supplied by the upstream live source.
//
// The parser keeps three things apart: media sequence numbers, declared
// segment durations (presentation time), and PROGRAM-DATE-TIME declarations.
// Nothing here turns durations into wall-clock capture time.

export class PlaylistError extends Error {
  constructor(message, { line } = {}) {
    super(message);
    this.name = 'PlaylistError';
    this.line = line ?? null;
  }
}

export function parseAttributes(value) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(value))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function absoluteUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    throw new PlaylistError(`invalid segment URI: ${uri}`);
  }
}

function parsePdt(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new PlaylistError(`invalid PROGRAM-DATE-TIME: ${value}`);
  return ms;
}

export function parseMediaPlaylist(text, baseUrl) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PlaylistError('empty playlist');
  }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (first >= lines.length || lines[first].trim() !== '#EXTM3U') {
    throw new PlaylistError('missing #EXTM3U header', { line: first + 1 });
  }

  const playlist = {
    version: 1,
    targetDuration: null,
    mediaSequence: 0,
    discontinuitySequence: 0,
    endList: false,
    segments: [],
  };

  let pendingDuration = null;
  let pendingDiscontinuity = false;
  let pendingPdt = null;
  let pendingGap = false;
  let pendingByteRange = null;
  let pendingFrames = null;
  let pendingFps = null;
  let currentInit = null;
  let currentDiscSeq = 0;

  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (!line.startsWith('#')) {
      if (pendingDuration === null) {
        throw new PlaylistError('segment URI without EXTINF', { line: i + 1 });
      }
      const uri = absoluteUri(line, baseUrl);
      playlist.segments.push({
        sequence: playlist.mediaSequence + playlist.segments.length,
        discontinuitySequence: currentDiscSeq,
        discontinuity: pendingDiscontinuity,
        duration: pendingDuration,
        declaredPdt: pendingPdt,
        gap: pendingGap,
        byteRange: pendingByteRange,
        frameRange: pendingFrames,
        init: currentInit,
        uri,
      });
      pendingDuration = null;
      pendingDiscontinuity = false;
      pendingPdt = null;
      pendingGap = false;
      pendingByteRange = null;
      pendingFrames = null;
      continue;
    }

    const colon = line.indexOf(':');
    const tag = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);

    switch (tag) {
      case '#EXT-X-VERSION':
        playlist.version = Number(value);
        break;
      case '#EXT-X-TARGETDURATION':
        playlist.targetDuration = Number(value);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        if (playlist.segments.length > 0) {
          throw new PlaylistError('EXT-X-MEDIA-SEQUENCE must precede segments', { line: i + 1 });
        }
        playlist.mediaSequence = Number(value);
        break;
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        if (playlist.segments.length > 0) {
          throw new PlaylistError('EXT-X-DISCONTINUITY-SEQUENCE must precede segments', {
            line: i + 1,
          });
        }
        currentDiscSeq = Number(value);
        playlist.discontinuitySequence = currentDiscSeq;
        break;
      case '#EXT-X-ENDLIST':
        playlist.endList = true;
        break;
      case '#EXT-X-MAP': {
        const attrs = parseAttributes(value);
        if (!attrs.URI) throw new PlaylistError('EXT-X-MAP without URI', { line: i + 1 });
        currentInit = { uri: absoluteUri(attrs.URI, baseUrl), byteRange: attrs.BYTERANGE ?? null };
        break;
      }
      case '#EXTINF': {
        const comma = value.indexOf(',');
        const numeric = comma === -1 ? value : value.slice(0, comma);
        const duration = Number.parseFloat(numeric);
        if (!Number.isFinite(duration) || duration < 0) {
          throw new PlaylistError(`invalid EXTINF duration: ${value}`, { line: i + 1 });
        }
        pendingDuration = duration;
        break;
      }
      case '#EXT-X-PROGRAM-DATE-TIME':
        pendingPdt = parsePdt(value);
        break;
      case '#EXT-X-DISCONTINUITY':
        pendingDiscontinuity = true;
        currentDiscSeq += 1;
        break;
      case '#EXT-X-GAP':
        pendingGap = true;
        break;
      case '#EXT-X-FRAME-RANGE': {
        // Custom declaration from the source: first and last capture frame
        // numbers carried by the segment. Never used as a time source.
        const [a, b] = value.split('-');
        const firstFrame = Number(a);
        const lastFrame = Number(b);
        if (!Number.isInteger(firstFrame) || !Number.isInteger(lastFrame) || lastFrame < firstFrame) {
          throw new PlaylistError(`invalid EXT-X-FRAME-RANGE: ${value}`, { line: i + 1 });
        }
        pendingFrames = { first: firstFrame, last: lastFrame };
        break;
      }
      case '#EXT-X-BYTERANGE': {
        const [length, offset] = value.split('@');
        pendingByteRange = {
          length: Number(length),
          offset: offset === undefined ? null : Number(offset),
        };
        break;
      }
      default:
      // Unknown tags are ignored; unknown non-tag URI lines are rejected above.
    }
  }

  if (pendingDuration !== null) {
    throw new PlaylistError('trailing EXTINF without segment URI');
  }
  return playlist;
}
