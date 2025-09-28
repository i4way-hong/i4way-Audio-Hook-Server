#include <napi.h>
#include <thread>
#include <atomic>
#include <map>
#include <mutex>
#include <chrono>
#include <condition_variable>

// Skeleton only: wire up JS API surface expected by unimrcp-signaling.ts
// TODO: Replace with actual UniMRCP client SDK calls and a worker thread that handles SIP/RTSP & MRCP events.

#ifdef USE_UNIMRCP_SDK
// UniMRCP / APR headers
// These headers become available when binding.gyp is configured with use_unimrcp_sdk=1 and include dirs.
// NOTE: Detailed MRCP session/channel code will be added in the next step.
#include <apr_general.h>
#include <apt.h>
#include <apt_log.h>
#include <apt_dir_layout.h>
#include <mrcp_client.h>
#include <mrcp_application.h>
#include <mrcp_client_session.h>
#include <mrcp_client_types.h>
#include <mpf_rtp_termination_factory.h>
#include <mpf_rtp_descriptor.h>
#include <mpf_termination.h>
#include <mrcp_recog_resource.h>
#include <mrcp_recog_header.h>
#endif

class SessionHandle : public Napi::ObjectWrap<SessionHandle> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "SessionHandle", {});
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    exports.Set("SessionHandle", func);
    return exports;
  }
  SessionHandle(const Napi::CallbackInfo& info) : Napi::ObjectWrap<SessionHandle>(info) {}
  static Napi::FunctionReference constructor;
};

Napi::FunctionReference SessionHandle::constructor;

struct NativeRemoteInfo {
  std::string remoteIp;
  uint32_t remotePort;
  uint32_t payloadType;
  uint32_t handleId;
};

struct HandleState {
  std::atomic<bool> running{false};
  std::thread worker;
  Napi::ThreadSafeFunction tsfn; // emits result/closed/error
#ifdef USE_UNIMRCP_SDK
  apt_dir_layout_t* dirLayout = nullptr;
  mrcp_client_t* client = nullptr;
  mrcp_application_t* app = nullptr;
  mrcp_session_t* session = nullptr;
  mrcp_channel_t* channel = nullptr;
  void* appCtx = nullptr;
  // Negotiated values
  std::string rip;
  uint32_t rport = 0;
  uint16_t ptime = 0;
  bool channelAdded = false;
#endif
};

static std::mutex g_mutex;
static std::condition_variable g_cv;
static std::map<uint32_t, HandleState> g_handles;
static uint32_t g_nextHandle = 1;

#ifdef USE_UNIMRCP_SDK
// Global APR init guard
static std::atomic<int> g_aprInitCount{0};
static std::mutex g_aprMutex;

static void SdkInitIfNeeded() {
  std::lock_guard<std::mutex> lk(g_aprMutex);
  if (g_aprInitCount.load() == 0) {
    apr_status_t rc = apr_initialize();
    (void)rc; // suppress unused on non-debug builds
    // In a full implementation we may also create an apt log instance and dir layout here.
  }
  g_aprInitCount.fetch_add(1);
}

static void SdkTerminateIfNeeded() {
  std::lock_guard<std::mutex> lk(g_aprMutex);
  int cnt = g_aprInitCount.load();
  if (cnt > 0) {
    cnt = g_aprInitCount.fetch_sub(1) - 1;
    if (cnt == 0) {
      apr_terminate();
    }
  }
}

struct AppCtx {
  uint32_t handleId;
};

static apt_bool_t on_channel_add(mrcp_application_t *application, mrcp_session_t *session, mrcp_channel_t *channel, mrcp_sig_status_code_e status) {
  void* obj = mrcp_application_session_object_get(session);
  AppCtx* ctx = static_cast<AppCtx*>(obj);
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (!ctx) {
      g_cv.notify_all();
      return TRUE;
    }
    auto it = g_handles.find(ctx->handleId);
    if (it != g_handles.end()) {
      HandleState &st = it->second;
      st.channel = channel;
      if (status == MRCP_SIG_STATUS_CODE_SUCCESS) {
        mpf_rtp_termination_descriptor_t* rtpDesc = mrcp_application_rtp_descriptor_get(channel);
        if (rtpDesc && rtpDesc->audio.remote) {
          auto *remote = rtpDesc->audio.remote;
          if (remote->ip.buf && remote->ip.length) st.rip.assign(remote->ip.buf, remote->ip.length);
          st.rport = remote->port;
          st.ptime = remote->ptime ? remote->ptime : st.ptime;
        }
        if ((!st.rport || st.rip.empty()) && rtpDesc && rtpDesc->audio.local) {
          auto *local = rtpDesc->audio.local;
          if (local->ip.buf && local->ip.length) st.rip.assign(local->ip.buf, local->ip.length);
          if (!st.rport) st.rport = local->port;
          if (!st.ptime && local->ptime) st.ptime = local->ptime;
        }
        if (!st.ptime) st.ptime = 20;
      }
      st.channelAdded = true;
    }
  }
  g_cv.notify_all();
  return TRUE;
}

static apt_bool_t on_message_receive(mrcp_application_t *application, mrcp_session_t *session, mrcp_channel_t *channel, mrcp_message_t *message) {
  void* obj = mrcp_application_session_object_get(session);
  AppCtx* ctx = static_cast<AppCtx*>(obj);
  if (!ctx) return TRUE;
  std::shared_ptr<Napi::ThreadSafeFunction> tsfnShared;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_handles.find(ctx->handleId);
    if (it != g_handles.end() && it->second.tsfn) {
      tsfnShared = std::make_shared<Napi::ThreadSafeFunction>(it->second.tsfn);
    }
  }
  if (tsfnShared) {
    // Capture needed data before invoking JS
    mrcp_message_t *msg = message; // local alias
    mrcp_recog_header_t *recog_hdr = nullptr;
    int completion_cause = -1;
    if (msg && msg->start_line.message_type == MRCP_MESSAGE_TYPE_EVENT && msg->start_line.method_id == RECOGNIZER_RECOGNITION_COMPLETE) {
      recog_hdr = (mrcp_recog_header_t*) mrcp_resource_header_get(msg);
      if (recog_hdr) completion_cause = (int)recog_hdr->completion_cause;
    }

static apt_bool_t on_terminate_event(mrcp_application_t *application, mrcp_session_t *session, mrcp_channel_t *channel) {
  void* obj = mrcp_application_session_object_get(session);
  AppCtx* ctx = static_cast<AppCtx*>(obj);
  std::shared_ptr<Napi::ThreadSafeFunction> tsfnShared;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (ctx) {
      auto it = g_handles.find(ctx->handleId);
      if (it != g_handles.end() && it->second.tsfn) {
        tsfnShared = std::make_shared<Napi::ThreadSafeFunction>(it->second.tsfn);
      }
    }
  }
  if (tsfnShared) {
    tsfnShared->BlockingCall([](Napi::Env env, Napi::Function jsCallback){
      Napi::Object ev = Napi::Object::New(env);
      ev.Set("type", "closed");
      ev.Set("reason", "terminated");
      jsCallback.Call({ ev });
    });
  }
  return TRUE;
}
#endif

Napi::Value OpenSession(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // args[0]: object { endpoint, profileId, codec, sampleRate, rtpPortMin, rtpPortMax }
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "expected options object").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object opts = info[0].As<Napi::Object>();
  std::string endpoint = opts.Get("endpoint").ToString();
  std::string profileId = opts.Get("profileId").ToString();
  std::string codec = opts.Get("codec").ToString();
  uint32_t sampleRate = opts.Get("sampleRate").ToNumber().Uint32Value();
  uint32_t rtpMin = opts.Get("rtpPortMin").ToNumber().Uint32Value();
  uint32_t rtpMax = opts.Get("rtpPortMax").ToNumber().Uint32Value();
  (void)endpoint; (void)profileId; (void)codec; (void)sampleRate; (void)rtpMin; (void)rtpMax;

#ifdef USE_UNIMRCP_SDK
  SdkInitIfNeeded();
  std::string root;
  if (const char* p = std::getenv("UNIMRCP_ROOT")) root = p;  if (root.empty()) {
    // Default to app/configs/unimrcp (process working directory = app)
    root = "configs/unimrcp";
  }
  apt_dir_layout_t* dirLayout = apt_default_dir_layout_create(root.c_str(), nullptr);
  mrcp_client_t* client = dirLayout ? mrcp_client_create(dirLayout) : nullptr;
  if (client) mrcp_client_start(client);

  mrcp_application_message_handler_fns appFns{};
  appFns.on_channel_add = on_channel_add;
  appFns.on_message_receive = on_message_receive;
  appFns.on_terminate_event = on_terminate_event;
  mrcp_application_t* app = client ? mrcp_application_create(&appFns, client, nullptr) : nullptr;

  uint32_t hid = g_nextHandle++;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    HandleState &st = g_handles[hid];
    st.running = true;
    st.dirLayout = dirLayout;
    st.client = client;
    st.app = app;
  }

  mrcp_session_t* session = app ? mrcp_application_session_create(app, profileId.c_str(), nullptr) : nullptr;
  AppCtx* ctx = nullptr;
  if (session) {
    ctx = new AppCtx{ hid };
    mrcp_application_session_object_set(session, ctx);
    {
      std::lock_guard<std::mutex> lk(g_mutex);
      g_handles[hid].session = session;
      g_handles[hid].appCtx = ctx;
    }
  }

  mrcp_channel_t* channel = nullptr;
  if (session) {
    mrcp_resource_id resource_id = MRCP_RECOGNIZER_RESOURCE;
    channel = mrcp_application_channel_create(session, resource_id, nullptr, nullptr, nullptr);
    if (channel) {
      // preconfigure PT/ptime
      if (auto *rtpDesc = mrcp_application_rtp_descriptor_get(channel)) {
        rtpDesc->audio.settings.payload_type = (codec == "PCMU") ? 0 : 96;
        if (rtpDesc->audio.local) {
          rtpDesc->audio.local->ptime = static_cast<apr_uint16_t>(20);
        }
      }
      // send add and wait for negotiation
      mrcp_application_channel_add(session, channel);
    }
  }

  // Wait up to 3s for channel add to complete and SDP to arrive
  std::string rip = "";
  uint32_t rport = 0;
  uint16_t ptime = 0;
  {
    std::unique_lock<std::mutex> lk(g_mutex);
    g_cv.wait_for(lk, std::chrono::milliseconds(3000), [hid]{
      auto it = g_handles.find(hid);
      return it != g_handles.end() && it->second.channelAdded;
    });
    auto it = g_handles.find(hid);
    if (it != g_handles.end()) {
      rip = it->second.rip;
      rport = it->second.rport;
      ptime = it->second.ptime ? it->second.ptime : 20;
      it->second.channel = channel ? channel : it->second.channel;
    }
  }
  if (rip.empty()) rip = "127.0.0.1";
  if (!rport) rport = 5004;

  Napi::Object result = Napi::Object::New(env);
  result.Set("remoteIp", rip);
  result.Set("remotePort", rport);
  result.Set("payloadType", codec == "PCMU" ? 0 : 96);
  result.Set("handle", hid);
  result.Set("ptimeMs", Napi::Number::New(env, static_cast<double>(ptime ? ptime : 20)));
  result.Set("localPort", Napi::Number::New(env, rtpMin));
  return result;
#else
  // Temporary non-SDK path
  NativeRemoteInfo out { "127.0.0.1", 5004, codec == "PCMU" ? 0u : 96u, g_nextHandle++ };
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    HandleState &st = g_handles[out.handleId];
    st.running = true;
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("remoteIp", out.remoteIp);
  result.Set("remotePort", out.remotePort);
  result.Set("payloadType", out.payloadType);
  result.Set("handle", out.handleId);
  result.Set("localPort", Napi::Number::New(env, rtpMin));
  result.Set("ptimeMs", Napi::Number::New(env, 20));
  return result;
#endif
}

Napi::Value OnEvent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "expected (handle:number, callback:function)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uint32_t handleId = info[0].As<Napi::Number>().Uint32Value();
  Napi::Function cb = info[1].As<Napi::Function>();

  HandleState *stPtr = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_handles.find(handleId);
    if (it == g_handles.end()) {
      Napi::Error::New(env, "invalid handle").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    stPtr = &it->second;
    stPtr->tsfn = Napi::ThreadSafeFunction::New(
      env,
      cb,
      "mrcp-events",
      0,
      1
    );
  }

  // Demo worker which emits a single 'result' after 5s
#ifdef USE_UNIMRCP_SDK
  // Also prepare AppCtx for SDK callbacks
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_handles.find(handleId);
    if (it != g_handles.end()) {
      // nothing yet, tsfn set above
    }
  }
#endif
  stPtr->worker = std::thread([handleId]() {
    using namespace std::chrono_literals;
    std::this_thread::sleep_for(5s);
    HandleState *st = nullptr;
    {
      std::lock_guard<std::mutex> lk(g_mutex);
      auto it = g_handles.find(handleId);
      if (it == g_handles.end()) {
        return;
      }
      st = &it->second;
      if (!st->running.load()) return;
    }
    if (st->tsfn) {
      st->tsfn.BlockingCall([](Napi::Env env, Napi::Function jsCallback) {
        Napi::Object ev = Napi::Object::New(env);
        ev.Set("type", "result");
        ev.Set("text", "demo result (native)");
        jsCallback.Call({ ev });
      });
    }
  });

  return env.Undefined();
}

Napi::Value CloseSession(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "expected (handle:number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uint32_t handleId = info[0].As<Napi::Number>().Uint32Value();

  std::thread workerToJoin;
  Napi::ThreadSafeFunction tsfnToRelease;
  bool had = false;
  void* appCtxToDelete = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    auto it = g_handles.find(handleId);
    if (it != g_handles.end()) {
      it->second.running = false;
#ifdef USE_UNIMRCP_SDK
      appCtxToDelete = it->second.appCtx;
      it->second.appCtx = nullptr;
      if (it->second.session) {
        mrcp_application_session_terminate(it->second.session);
        mrcp_application_session_destroy(it->second.session);
        it->second.session = nullptr;
      }
      if (it->second.client) {
        mrcp_client_shutdown(it->second.client);
      }
      it->second.client = nullptr;
      it->second.app = nullptr;
      it->second.dirLayout = nullptr;
#endif
      // move resources we need to clean outside the lock
      if (it->second.worker.joinable()) {
        workerToJoin = std::move(it->second.worker);
      }
      tsfnToRelease = std::move(it->second.tsfn);
      g_handles.erase(it);
      had = true;
    }
  }
  if (had) {
    if (workerToJoin.joinable()) workerToJoin.join();
    if (tsfnToRelease) tsfnToRelease.Release();
#ifdef USE_UNIMRCP_SDK
    if (appCtxToDelete) delete static_cast<AppCtx*>(appCtxToDelete);
    SdkTerminateIfNeeded();
#endif
  }

  return env.Undefined();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  SessionHandle::Init(env, exports);
  exports.Set(Napi::String::New(env, "openSession"), Napi::Function::New(env, OpenSession));
  exports.Set(Napi::String::New(env, "onEvent"), Napi::Function::New(env, OnEvent));
  exports.Set(Napi::String::New(env, "closeSession"), Napi::Function::New(env, CloseSession));
  return exports;
}

NODE_API_MODULE(unimrcp, InitAll)
