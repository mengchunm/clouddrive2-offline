// @ts-ignore
import * as MP4Box from "mp4box";

interface Mp4SubtitleTrack {
  id: number;
  codec: string;
  language: string;
  name: string;
}

export interface Mp4SubtitleResult {
  url: string; // Object URL to the built VTT file
  name: string; // e.g. "Chi", "Eng"
  ext: string; // "vtt"
}

// Map from ISO 639-2 text to normal names 
const langMap: Record<string, string> = {
  chi: "中文(zh)",
  zho: "中文(zh)",
  eng: "英文(en)",
  jpn: "日文(ja)",
  kor: "韩文(ko)",
  spa: "西班牙文(es)",
  fre: "法文(fr)",
  ger: "德文(de)",
  ita: "意大利文(it)",
  rus: "俄文(ru)",
};

function formatTime(ms: number): string {
  const totalseconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalseconds / 3600);
  const minutes = Math.floor((totalseconds % 3600) / 60);
  const seconds = totalseconds % 60;
  const milliseconds = Math.floor(ms % 1000);

  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

/**
 * A lightweight MP4 subtitle extractor.
 * Mode: Manual moov parsing + stsz/stco targeted fetch + VTT conversion.
 */
export async function extractMp4Subtitle(
  videoUrl: string,
  fetchFn?: typeof fetch
): Promise<Mp4SubtitleResult[]> {
  const customFetch = fetchFn || window.fetch.bind(window);
  
  return new Promise((resolve, reject) => {
    const mp4boxfile = MP4Box.createFile();
    let isDone = false;
    let fileOffset = 0;
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB initially to fetch moov

    mp4boxfile.onError = (e: any) => {
      if (!isDone) {
        isDone = true;
        reject(new Error(`MP4Box Parse Error: ${e}`));
      }
    };

    mp4boxfile.onReady = async (info: any) => {
      if (isDone) return;
      isDone = true;
      
      const targetTracks: Mp4SubtitleTrack[] = [];
      for (const track of info.tracks) {
        if (
          track.codec === "tx3g" || 
          track.codec === "text" || 
          track.is_subtitle
        ) {
          let lang = track.language || "und";
          let name = track.name || langMap[lang] || lang;
          targetTracks.push({
            id: track.id,
            codec: track.codec,
            language: lang,
            name: name,
          });
        }
      }

      if (targetTracks.length === 0) {
        resolve([]);
        return;
      }

      console.log("[mp4Parser] Extracting subs for:", targetTracks);

      const results: Mp4SubtitleResult[] = [];

      for (const t of targetTracks) {
        try {
          // get the trak box
          const trak = (mp4boxfile as any).moov.traks.find((tr: any) => tr.tkhd.track_id === t.id);
          if (!trak) continue;

          const stbl = trak.mdia.minf.stbl;
          const stsz = stbl.stsz.sample_sizes;
          let offsets = stbl.stco ? stbl.stco.chunk_offsets : (stbl.co64 ? stbl.co64.chunk_offsets : null);
          const stsc = stbl.stsc.samples_table;
          const stts = stbl.stts.sample_counts; // durations
          
          if (!stsz || !offsets || !stsc || !stts) continue;

          const timeScale = trak.mdia.mdhd.timescale;
          let currentTime = 0;
          let sampleIndex = 0;
          let chunkIndex = 0; // 0-based indexing for our iteration
          
          interface Sample {
            offset: number;
            size: number;
            startTime: number;
            duration: number;
            endTime: number;
          }
          
          const samples: Sample[] = [];
          
          // Flatten stts
          const durations: number[] = [];
          for (let i = 0; i < stts.length; i++) {
            const count = stbl.stts.sample_counts[i];
            const delta = stbl.stts.sample_deltas[i];
            for (let j = 0; j < count; j++) {
              durations.push(delta);
            }
          }
          
          const defaultSampleSize = stbl.stsz.sample_size;

          // Expand stsc to map samples to chunks
          // stsc items are: { first_chunk, samples_per_chunk, sample_description_index }
          // Note: first_chunk is 1-based
          let stscIndex = 0;
          let currentChunkSamples = stsc[stscIndex].samples_per_chunk;
          let firstChunk = stsc[stscIndex].first_chunk;
          let nextFirstChunk = stscIndex + 1 < stsc.length ? stsc[stscIndex + 1].first_chunk : Infinity;
          
          let chunkSampleOffset = 0;
          let currentChunkOffset = offsets[0];
          
          for (let i = 0; i < durations.length; i++) {
            if (chunkIndex + 1 >= nextFirstChunk) {
              stscIndex++;
              currentChunkSamples = stsc[stscIndex].samples_per_chunk;
              nextFirstChunk = stscIndex + 1 < stsc.length ? stsc[stscIndex + 1].first_chunk : Infinity;
            }
            
            const size = defaultSampleSize > 0 ? defaultSampleSize : stsz[i];
            const duration = durations[i];
            
            samples.push({
               offset: currentChunkOffset + chunkSampleOffset,
               size: size,
               startTime: currentTime,
               duration: duration,
               endTime: currentTime + duration,
            });
            
            currentTime += duration;
            chunkSampleOffset += size;
            
            // If we have exhausted samples for the current chunk, move to next chunk
            if ((i + 1) - sampleIndex >= currentChunkSamples) {
               chunkIndex++;
               chunkSampleOffset = 0;
               if (chunkIndex < offsets.length) {
                 currentChunkOffset = offsets[chunkIndex];
               }
               sampleIndex = i + 1;
            }
          }

          // Aggregate byte ranges to minimize network requests
          // If samples are close together (e.g. within 256KB), merge the fetch requests
          const fetchRanges: {start: number, end: number, data?: Uint8Array}[] = [];
          for (const s of samples) {
             if (s.size === 0) continue;
             const start = s.offset;
             const end = s.offset + s.size - 1;
             
             if (fetchRanges.length > 0) {
               const last = fetchRanges[fetchRanges.length - 1];
               if (start - last.end <= 256 * 1024) { // Merge within 256KB
                 last.end = Math.max(last.end, end);
                 continue;
               }
             }
             fetchRanges.push({start, end});
          }

          // Fetch all ranges
          for (const range of fetchRanges) {
            const res = await customFetch(videoUrl, {
              headers: { Range: `bytes=${range.start}-${range.end}` }
            });
            if (!res.ok && res.status !== 206) throw new Error(`HTTP Error: ${res.status}`);
            const buf = await res.arrayBuffer();
            range.data = new Uint8Array(buf);
          }

          // Generate VTT
          let vttContent = "WEBVTT\n\n";

          for (const s of samples) {
             if (s.size === 0) continue;
             // Find the corresponding range buffer
             const range = fetchRanges.find(r => s.offset >= r.start && (s.offset + s.size - 1) <= r.end);
             if (!range || !range.data) continue;
             
             const localOffset = s.offset - range.start;
             const buf = range.data.subarray(localOffset, localOffset + s.size);
             
             // tx3g format parsing
             // Typically first 2 bytes are the text length. Then text bytes.
             if (buf.length >= 2) {
               const textLen = (buf[0] << 8) | buf[1];
               if (textLen > 0 && 2 + textLen <= buf.length) {
                 const textBuf = buf.subarray(2, 2 + textLen);
                 const decoder = new TextDecoder("utf-8");
                 let text = decoder.decode(textBuf); // mostly utf-8
                 
                 // replace tx3g styling or carriage returns if any
                 text = text.replace(/\r/g, "");
                 
                 const startMs = (s.startTime / timeScale) * 1000;
                 const endMs = (s.endTime / timeScale) * 1000;
                 
                 vttContent += `${formatTime(startMs)} --> ${formatTime(endMs)}\n${text}\n\n`;
               }
             }
          }

          results.push({
             url: URL.createObjectURL(new Blob([vttContent], { type: "text/vtt" })),
             name: t.name,
             ext: "vtt"
          });

        } catch (e) {
          console.error(`[mp4Parser] Error extracting track ${t.id}`, e);
        }
      }

      resolve(results);
    };

    // Kick off moov fetch
    async function startFetch() {
      try {
        const res = await customFetch(videoUrl, {
          headers: { Range: `bytes=${fileOffset}-${fileOffset + CHUNK_SIZE - 1}` }
        });
        if (!res.ok && res.status !== 206) {
           throw new Error(`Failed to fetch MP4 header: ${res.status}`);
        }
        
        const ab = await res.arrayBuffer();
        if (ab.byteLength === 0) {
           if (!isDone) {
             isDone = true;
             resolve([]); // Could not read header
           }
           return;
        }

        (ab as any).fileStart = fileOffset;
        fileOffset += ab.byteLength;
        const nextPosition = mp4boxfile.appendBuffer(ab as any);
        
        if (!isDone) {
          // mp4box signals where to fetch next if it hasn't found moov yet
          if (nextPosition != null && nextPosition >= fileOffset) {
             // We need to jump or continue
             fileOffset = nextPosition;
             startFetch();
          } else if (fileOffset < 10 * 1024 * 1024) {
             // Keep downloading up to 10MB just in case it needs more for moov
             startFetch();
          } else {
             reject(new Error("moov box not found within first 10MB"));
          }
        }
      } catch (e) {
        if (!isDone) {
           isDone = true;
           reject(e);
        }
      }
    }
    
    startFetch();
  });
}
