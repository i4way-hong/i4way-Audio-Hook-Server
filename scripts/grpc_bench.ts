/* Simple gRPC streaming STT benchmark script
 * Usage: ts-node scripts/grpc_bench.ts --sessions=10 --seconds=15 --rate=8000 --bytes=320 
 * Sends silent audio frames at given rate to measure qps / latency (write roundtrip) for StreamingRecognize
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

interface Args { sessions: number; seconds: number; rate: number; bytes: number; }
function parseArgs(): Args {
  const a: Record<string,string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/); if (m) a[m[1]] = m[2];
  }
  return {
    sessions: parseInt(a.sessions||'5',10),
    seconds: parseInt(a.seconds||'10',10),
    rate: parseInt(a.rate||process.env.STT_RATE||'8000',10),
    bytes: parseInt(a.bytes||'320',10),
  };
}

const args = parseArgs();
const def = protoLoader.loadSync(path.resolve(process.cwd(),'proto','speech_transcription.proto'), { longs:String,enums:String,defaults:true,oneofs:true });
const pkg: any = grpc.loadPackageDefinition(def); // eslint-disable-line @typescript-eslint/no-explicit-any
const Svc = pkg.audiohook.stt.v1.SpeechTranscription;

const endpoint = process.env.STT_ENDPOINT || 'localhost:50051';
// Embedded server token (GRPC_AUTH_TOKEN) deprecated; only use STT_GRPC_AUTH_TOKEN
const auth = process.env.STT_GRPC_AUTH_TOKEN;
const tlsEnabled = /^(1|true|yes)$/i.test(process.env.STT_GRPC_TLS_ENABLED||'');
let creds: grpc.ChannelCredentials;
try {
  if (tlsEnabled) {
    creds = grpc.credentials.createSsl();
  } else { creds = grpc.credentials.createInsecure(); }
} catch { creds = grpc.credentials.createInsecure(); }

interface SessionStats { writes: number; transcripts: number; finals: number; }

async function startSession(id: number): Promise<SessionStats> {
  const client = new Svc(endpoint, creds);
  const md = new grpc.Metadata();
  if (auth) md.set('authorization', 'Bearer '+auth);
  const stream = client.StreamingRecognize(md);
  const stats: SessionStats = { writes:0, transcripts:0, finals:0 };
  stream.on('data', (msg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (msg.transcript) {
      stats.transcripts++; if (msg.transcript.is_final) stats.finals++; }
  });
  stream.on('error', (e:Error)=>{ console.error(`[sess ${id}] error ${e.message}`); });
  let started = false;
  function sendInit(){
    if (started) return; started = true;
    stream.write({ init: { language_code:'ko-KR', sample_rate_hz: args.rate, encoding: 'LINEAR16', enable_interim_results:true, single_utterance:false, enable_word_time_offsets:false }, client_session_id:`bench-${id}-${Date.now()}` });
  }
  sendInit();
  const silence = Buffer.alloc(args.bytes,0);
  const frameIntervalMs = Math.round(1000 * args.bytes / (2 * args.rate)); // 2 bytes per sample (L16 mono assumption)
  const endAt = Date.now() + args.seconds*1000;
  return new Promise<SessionStats>((resolve) => {
    function pump(){
      if (Date.now() >= endAt) { try { stream.end(); } catch {} return resolve(stats); }
      try { stream.write({ audio: { data: silence, sequence: stats.writes++, end_of_stream:false } }); } catch {}
      setTimeout(pump, frameIntervalMs);
    }
    pump();
  });
}

async function main(){
  console.log(`Benchmark start sessions=${args.sessions} seconds=${args.seconds} endpoint=${endpoint}`);
  const started = Date.now();
  const promises: Promise<SessionStats>[] = [];
  for (let i=0;i<args.sessions;i++){ promises.push(startSession(i)); }
  const results = await Promise.all(promises);
  const elapsed = (Date.now()-started)/1000;
  const agg = results.reduce((a,b)=>{ a.writes+=b.writes; a.transcripts+=b.transcripts; a.finals+=b.finals; return a; }, {writes:0,transcripts:0,finals:0});
  console.log(`Done in ${elapsed.toFixed(2)}s totalWrites=${agg.writes} transcripts=${agg.transcripts} finals=${agg.finals}`);
  console.log(`Writes/sec ${(agg.writes/elapsed).toFixed(1)} transcripts/sec ${(agg.transcripts/elapsed).toFixed(1)}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
