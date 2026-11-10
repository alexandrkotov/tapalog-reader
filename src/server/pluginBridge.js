// The part of an isolated plugin that runs inside its sandboxed frame (see src/server/pluginHost.ts).
//
// The frame has no way to reach the program's page, its cookies or its login: the program's page and this script talk by
// messages only, and the frame's origin is opaque. This script loads the plugin's module, hands it a context in the shape the
// plugin API 2 describes, and turns what the plugin does into messages:
//
//   program -> frame   init {reader, mode: "mount" | "cover", api, name, ext, view, theme, width, height}   once, first
//                      file {id, buffer} | {id, error}     the answer to need-file
//                      theme {theme}                       the reader's theme changed
//                      destroy                             the reader is closed
//   frame -> program   ready                               the script is loaded and waits for init
//                      mounted | failed {message}          the plugin's mount finished
//                      view {view, label}                  the place changed (view is plain JSON, label may be empty)
//                      error {title, text}                 the plugin tells the reader the book cannot be shown
//                      need-file {id}                      the plugin asked for the book's bytes
//                      cover {image} | cover-failed {message, retry}   the answer of a cover request
//
// Messages are taken only from the program's page (event.source is the parent window).
(function () {
  "use strict";
  var host = window.parent;
  var started = false;
  var calls = new Map();
  var nextCall = 1;
  var bytes = null;
  var themeFns = [];
  var instance = null;
  var timer = 0;
  var lastKey = "";

  function post(message, transfer) {
    host.postMessage(message, "*", transfer || []); // the frame cannot know the program's origin, and only its page can be the parent
  }
  var describe = function (e) {
    return e instanceof Error ? e.message : String(e);
  };

  /** The book's bytes, asked from the program once (it fetches them with the reader's login); every call gets its own copy. */
  function file() {
    if (!bytes) {
      bytes = new Promise(function (resolve, reject) {
        var id = nextCall++;
        calls.set(id, { resolve: resolve, reject: reject });
        post({ t: "need-file", id: id });
      });
      bytes.catch(function () {
        bytes = null; // asked again next time
      });
    }
    return bytes.then(function (buffer) {
      return buffer.slice(0);
    });
  }

  function sendView(view) {
    var json;
    try {
      json = JSON.stringify(view === undefined ? null : view);
    } catch (e) {
      return; // not plain data: nothing to keep
    }
    var label = "";
    try {
      if (instance && typeof instance.getLabel === "function") label = String(instance.getLabel() || "");
    } catch (e) {
      /* a label is only a suggestion */
    }
    var key = json + "\u0000" + label;
    if (key === lastKey) return;
    lastKey = key;
    post({ t: "view", view: JSON.parse(json), label: label });
  }
  function report() {
    if (!instance || typeof instance.getView !== "function") return;
    try {
      sendView(instance.getView());
    } catch (e) {
      /* the next poll tries again */
    }
  }

  function setTheme(theme) {
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
  }

  async function cover(module, m) {
    if (typeof module.cover !== "function") return post({ t: "cover-failed", message: "the plugin draws no covers", retry: false });
    try {
      var image = await module.cover({ api: m.api, ext: m.ext, width: m.width, height: m.height, file: file });
      if (!(image instanceof Blob)) image = await createImageBitmap(image); // a canvas cannot be sent, a bitmap can
      post({ t: "cover", image: image }, image instanceof Blob ? [] : [image]);
    } catch (e) {
      post({ t: "cover-failed", message: describe(e), retry: e instanceof TypeError }); // a failed fetch is tried again later, as for plugins in the page
    }
  }

  async function start(m) {
    if (started) return;
    started = true;
    setTheme(m.theme);
    try {
      var module = await import(m.reader);
      if (m.mode === "cover") return await cover(module, m);
      if (typeof module.mount !== "function") throw new Error("the reader has no mount function");
      instance = await module.mount(document.body, {
        api: m.api,
        name: m.name,
        ext: m.ext,
        view: m.view === undefined ? null : m.view,
        theme: m.theme,
        file: file,
        onView: sendView,
        onError: function (title, text) {
          post({ t: "error", title: String(title), text: String(text) });
        },
        onTheme: function (fn) {
          themeFns.push(fn);
          return function () {
            themeFns = themeFns.filter(function (x) {
              return x !== fn;
            });
          };
        },
      });
      timer = setInterval(report, 500); // the program asks for the view when it saves a place, and cannot ask a frame in the middle of that
      post({ t: "mounted" });
    } catch (e) {
      post({ t: "failed", message: describe(e) });
    }
  }

  function stop() {
    clearInterval(timer);
    try {
      if (instance && typeof instance.destroy === "function") instance.destroy();
    } catch (e) {
      /* closing anyway */
    }
    instance = null;
    document.body.replaceChildren();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var m = event.data;
    if (!m || typeof m.t !== "string") return;
    if (m.t === "init") void start(m);
    else if (m.t === "file") {
      var call = calls.get(m.id);
      if (!call) return;
      calls.delete(m.id);
      if (m.buffer instanceof ArrayBuffer) call.resolve(m.buffer);
      else call.reject(new TypeError(String(m.error || "the file could not be fetched")));
    } else if (m.t === "theme") {
      setTheme(m.theme);
      themeFns.slice().forEach(function (fn) {
        try {
          fn(m.theme);
        } catch (e) {
          /* one plugin callback must not stop the rest */
        }
      });
    } else if (m.t === "destroy") stop();
  });

  post({ t: "ready" });
})();
