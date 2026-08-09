package com.negotiatorcruz.rocketman;

import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the game out of the APK's assets over an https:// origin.
 *
 * <h2>Why not just load file:///android_asset/…</h2>
 *
 * Because the game would not work. A {@code file://} page gets an <em>opaque
 * origin</em> in a modern WebView, and two things follow from that, both fatal
 * here:
 *
 * <ul>
 *   <li><b>localStorage is unavailable.</b> Rocketman's entire campaign —
 *       pilots, levels, salvage, which missions are cleared, the mid-match
 *       autosave — lives in localStorage. On an opaque origin the game falls
 *       back to its in-memory profile and quietly forgets everything the
 *       moment the app is closed. It would look like it worked, right up
 *       until a player lost a campaign.</li>
 *   <li><b>ES modules are blocked.</b> {@code rocketman.html} loads
 *       {@code main.js} as {@code type="module"}, and module scripts are
 *       subject to CORS, which a {@code file://} origin fails by definition.
 *       The page would render its shell and never boot.</li>
 * </ul>
 *
 * Giving the assets a real https origin fixes both at once and costs one
 * interceptor. {@code appassets.androidplatform.net} is the domain Google
 * reserves for exactly this — it is guaranteed never to resolve on the public
 * internet, so a request that somehow escaped this class fails closed rather
 * than reaching a stranger's server.
 *
 * <p>No {@code androidx.webkit} dependency, because forty lines of
 * {@link AssetManager} is the whole job, and Rocketman is built under a
 * no-runtime-dependency rule.
 */
final class GameAssetServer {

  /** Reserved by Google for app-asset serving; never resolves publicly. */
  static final String ORIGIN = "https://appassets.androidplatform.net";

  /** Where {@code syncGameAssets} puts the copied tree inside the APK. */
  private static final String ASSET_ROOT = "game";

  /** The page the shell opens. */
  static final String START_URL = ORIGIN + "/game/web/rocketman.html";

  private static final Map<String, String> MIME_TYPES = new HashMap<>();

  static {
    MIME_TYPES.put("html", "text/html");
    // Module scripts are MIME-checked strictly: serve JavaScript as anything
    // else — text/plain, application/octet-stream — and the WebView refuses to
    // execute it and the game never boots. This single line is load-bearing.
    MIME_TYPES.put("js", "text/javascript");
    MIME_TYPES.put("mjs", "text/javascript");
    MIME_TYPES.put("css", "text/css");
    MIME_TYPES.put("json", "application/json");
    MIME_TYPES.put("svg", "image/svg+xml");
    MIME_TYPES.put("png", "image/png");
    MIME_TYPES.put("jpg", "image/jpeg");
    MIME_TYPES.put("jpeg", "image/jpeg");
    MIME_TYPES.put("webp", "image/webp");
    MIME_TYPES.put("woff2", "font/woff2");
    // The audio pack. `decodeAudioData` works off the bytes and does not
    // consult the Content-Type, so these are not load-bearing the way the
    // JavaScript line above is — but a WebView handed application/octet-stream
    // for a media file logs a warning per take, and a boot that prints two
    // hundred warnings is a boot nobody reads the log of.
    MIME_TYPES.put("webm", "audio/webm");
    MIME_TYPES.put("m4a", "audio/mp4");
    MIME_TYPES.put("mp3", "audio/mpeg");
    MIME_TYPES.put("ogg", "audio/ogg");
    MIME_TYPES.put("opus", "audio/ogg");
    MIME_TYPES.put("wav", "audio/wav");
  }

  private final AssetManager assets;

  GameAssetServer(AssetManager assets) {
    this.assets = assets;
  }

  /** True if this URL is ours to answer. */
  static boolean handles(String url) {
    return url != null && url.startsWith(ORIGIN + "/");
  }

  /**
   * Resolve a request to a response, or a 404 — never null, so a typo in a
   * path shows up as a readable console error in the WebView rather than as a
   * silent fall-through to a network fetch the app has no permission to make.
   */
  WebResourceResponse serve(String url) {
    String path = pathOf(url);
    if (path == null) {
      return notFound("bad path");
    }

    try {
      InputStream stream = assets.open(path);
      WebResourceResponse response =
          new WebResourceResponse(mimeOf(path), "utf-8", stream);
      response.setStatusCodeAndReasonPhrase(200, "OK");

      Map<String, String> headers = new HashMap<>();
      // The assets are baked into the APK and versioned with it, so they can
      // never go stale relative to the shell.
      headers.put("Cache-Control", "public, max-age=31536000, immutable");
      // The app ships everything it runs; nothing should ever be embedding it.
      headers.put("X-Content-Type-Options", "nosniff");
      response.setResponseHeaders(headers);

      return response;
    } catch (IOException notThere) {
      return notFound(path);
    }
  }

  /**
   * URL to asset path, refusing anything that tries to climb out.
   *
   * <p>The traversal guard is not theatre. {@link AssetManager#open} resolves
   * {@code ..} happily, and an asset tree is not a security boundary — but the
   * habit of validating before touching the filesystem is, and this is the one
   * place in the app where an outside string becomes a path.
   */
  private static String pathOf(String url) {
    int queryAt = url.indexOf('?');
    String withoutQuery = queryAt >= 0 ? url.substring(0, queryAt) : url;
    int hashAt = withoutQuery.indexOf('#');
    String clean = hashAt >= 0 ? withoutQuery.substring(0, hashAt) : withoutQuery;

    String relative = clean.substring(ORIGIN.length());
    if (relative.startsWith("/")) {
      relative = relative.substring(1);
    }
    if (relative.isEmpty()) {
      return null;
    }
    // "game/web/main.js" is the only shape we serve; anything with a traversal
    // segment or a backslash is refused outright rather than normalised.
    if (relative.contains("..") || relative.contains("\\") || relative.contains("//")) {
      return null;
    }
    if (!relative.startsWith(ASSET_ROOT + "/")) {
      return null;
    }
    return relative;
  }

  private static String mimeOf(String path) {
    int dot = path.lastIndexOf('.');
    if (dot < 0) {
      return "application/octet-stream";
    }
    String extension = path.substring(dot + 1).toLowerCase(java.util.Locale.US);
    String mime = MIME_TYPES.get(extension);
    return mime != null ? mime : "application/octet-stream";
  }

  private static WebResourceResponse notFound(String what) {
    byte[] body = ("Rocketman: no asset at " + what).getBytes(StandardCharsets.UTF_8);
    WebResourceResponse response =
        new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(body));
    response.setStatusCodeAndReasonPhrase(404, "Not Found");
    return response;
  }
}
