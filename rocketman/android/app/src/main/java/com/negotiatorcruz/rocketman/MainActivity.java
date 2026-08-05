package com.negotiatorcruz.rocketman;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * The whole Fire OS app: one Activity, one WebView, one game.
 *
 * <p>Rocketman is already a self-contained web game with a touch control
 * scheme, a fixed-timestep loop that survives being backgrounded, and a
 * renderer that sizes itself to whatever viewport it is handed. So this class
 * deliberately does not port anything. It does the four things a Fire tablet
 * needs that a browser tab does not:
 *
 * <ol>
 *   <li>gives the assets a real origin (see {@link GameAssetServer}),</li>
 *   <li>takes the system furniture off the screen and keeps it off,</li>
 *   <li>stops the platform's own touch behaviours from eating the game's
 *       gestures — the long-press text menu in particular,</li>
 *   <li>makes the hardware Back button mean something.</li>
 * </ol>
 */
public final class MainActivity extends Activity {

  private static final String TAG = "Rocketman";

  /** How long a second Back press still counts as "yes, really quit". */
  private static final long EXIT_CONFIRM_WINDOW_MS = 2500L;

  private WebView web;
  private GameAssetServer server;
  private long firstBackPressAt = 0L;
  private Toast exitToast;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // An RTS is watched as much as it is touched — a build queue finishing, a
    // siege line walking forward. Letting a Fire tablet dim mid-match on its
    // default 30-second timeout would be its own kind of bug.
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    server = new GameAssetServer(getAssets());
    web = new WebView(this);
    configure(web);
    setContentView(web);

    goImmersive();

    // savedInstanceState is non-null only if the process was killed and
    // restored; the WebView's own state went with it, so the game reboots and
    // offers its autosave. Restoring a half-serialised WebView would be worse.
    web.loadUrl(GameAssetServer.START_URL);
  }

  /* ------------------------------------------------------------ webview -- */

  @SuppressWarnings("SetJavaScriptEnabled") // it is a JavaScript game
  private void configure(WebView view) {
    WebSettings settings = view.getSettings();

    settings.setJavaScriptEnabled(true);

    // The campaign lives here: pilots, levels, salvage, cleared missions, and
    // the five-second autosave. Off by default in a WebView, and the game is
    // built to degrade quietly rather than crash without it — which is exactly
    // why forgetting this line would ship a game that silently never saves.
    settings.setDomStorageEnabled(true);

    // Nothing is ever loaded from the filesystem or a content provider. The
    // asset server is the only door in, so close the others.
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);

    // Pinch-zoom belongs to the game's camera, not to the document. If the
    // WebView keeps it, a two-finger zoom scales the HUD instead of the
    // battlefield and there is no way back to 100%.
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    settings.setUseWideViewPort(false);
    settings.setLoadWithOverviewMode(false);

    // Fire tablets expose a system font-size slider, and a WebView honours it
    // by default. The HUD is laid out in pixels over a canvas, so a user with
    // large text set would get a command panel covering the map. The game's own
    // clamp()-based sizing is the accessibility story here.
    settings.setTextZoom(100);

    // Audio is synthesised in WebAudio and unlocked by the game on the first
    // pointerdown. Leaving the gesture requirement in place is what makes that
    // unlock legal, and keeps the app from making noise before it is touched.
    settings.setMediaPlaybackRequiresUserGesture(true);

    // Every byte comes out of the APK, versioned with the APK.
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

    // Matches the game's background colour, so launch goes dark-to-dark instead
    // of flashing white before the first canvas paint.
    view.setBackgroundColor(0xFF080B10);

    // A canvas game has nothing to scroll, and the stretch/glow at the edge of
    // a pan gesture reads as the app fighting you.
    view.setOverScrollMode(View.OVER_SCROLL_NEVER);
    view.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
    view.setHorizontalScrollBarEnabled(false);
    view.setVerticalScrollBarEnabled(false);

    // The single most important line for playability.
    //
    // Rocketman's touch scheme uses long-press for attack-move. Android's
    // WebView answers a long press with its own text-selection popup, which
    // both swallows the gesture and leaves a selection handle sitting on the
    // battlefield. Refusing the long click at the view level hands the gesture
    // back to the page, where input.js is already waiting for it.
    view.setLongClickable(false);
    view.setOnLongClickListener(v -> true);
    view.setHapticFeedbackEnabled(false);

    view.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
        String url = request.getUrl().toString();
        return GameAssetServer.handles(url) ? server.serve(url) : null;
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
        // The app has no INTERNET permission and one page. Anything trying to
        // navigate elsewhere is a bug, and swallowing it keeps the game from
        // ending up on a blank "webpage not available" screen with no way back.
        String url = request.getUrl().toString();
        if (GameAssetServer.handles(url)) {
          return false;
        }
        Log.w(TAG, "refused navigation to " + url);
        return true;
      }

      @Override
      public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
        // A killed renderer — Fire tablets are memory-tight and this does
        // happen — leaves a dead WebView that never paints again. Finishing is
        // honest: the game autosaves every five seconds, so the relaunch offers
        // to resume rather than losing the match.
        //
        // Returning true claims the crash. Returning false lets the platform
        // kill the whole app process instead, which is the same outcome for the
        // player but arrives as "Rocketman keeps stopping".
        Log.e(TAG, "webview render process gone; finishing");
        finish();
        return true;
      }
    });

    view.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onConsoleMessage(ConsoleMessage message) {
        // Surfaced through logcat so `adb logcat -s Rocketman` is a usable
        // on-device debugging loop for a game with no server to log to.
        Log.d(TAG, message.message() + " (" + message.sourceId() + ":"
            + message.lineNumber() + ")");
        return true;
      }
    });

    if (isDebuggable()) {
      // Enables chrome://inspect over adb against a sideloaded build. Gated on
      // the debuggable flag so a released APK is not inspectable.
      WebView.setWebContentsDebuggingEnabled(true);
    }
  }

  private boolean isDebuggable() {
    return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
  }

  /* --------------------------------------------------------- fullscreen -- */

  /**
   * Hide the status and navigation bars, and keep them hidden.
   *
   * <p>Two implementations because minSdk is 28: Fire OS 8 tablets are API 30
   * and take the {@link WindowInsetsController} path, Fire OS 7 tablets are API
   * 28 and take the deprecated one. Both end at the same place — a full-bleed
   * battlefield where a swipe from the edge brings the bars back transiently
   * rather than permanently.
   */
  private void goImmersive() {
    Window window = getWindow();

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false);
      WindowInsetsController controller = window.getInsetsController();
      if (controller != null) {
        controller.hide(WindowInsets.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      window.getDecorView().setSystemUiVisibility(
          View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    // The bars come back after a notification shade pull or a task switch, and
    // they do not leave again on their own.
    if (hasFocus) {
      goImmersive();
    }
  }

  /* --------------------------------------------------------------- back -- */

  /**
   * Ask the page whether it wants the Back press, and exit only if it does not.
   *
   * <p>The page answers through {@code window.rocketmanBack()}, which returns
   * true when it moved back a screen. On the title screen it returns false,
   * because the title screen is the top of the stack and Back there should
   * close the app — that is what the button means on a Fire tablet, and an app
   * that traps it fails review for good reason.
   *
   * <p>Deprecated on API 33+, where predictive back replaces it. That opt-in is
   * off (no {@code android:enableOnBackInvokedCallback}), so this still runs on
   * every Fire tablet in the field. It is flagged in the port README as the one
   * thing to revisit when Fire OS moves past API 33.
   */
  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    if (web == null) {
      super.onBackPressed();
      return;
    }

    web.evaluateJavascript(
        "(function(){try{"
            + "return !!(window.rocketmanBack && window.rocketmanBack());"
            + "}catch(e){return false;}})()",
        value -> {
          if ("true".equals(value)) {
            return;
          }
          confirmExit();
        });
  }

  /**
   * Two presses to leave.
   *
   * <p>A single press closing the app is how people lose a skirmish they were
   * winning. The game autosaves campaign missions, but a skirmish is a session,
   * and a confirmation is cheaper than a dialog and less rude than trapping the
   * button.
   */
  private void confirmExit() {
    long now = System.currentTimeMillis();
    if (now - firstBackPressAt < EXIT_CONFIRM_WINDOW_MS) {
      if (exitToast != null) {
        exitToast.cancel();
      }
      finish();
      return;
    }

    firstBackPressAt = now;
    exitToast = Toast.makeText(this, R.string.exit_confirm, Toast.LENGTH_SHORT);
    exitToast.show();
  }

  /* ------------------------------------------------------------ lifecycle -- */

  @Override
  protected void onPause() {
    super.onPause();
    if (web != null) {
      // onPause alone leaves timers running; pauseTimers is what actually stops
      // the game's rAF loop and the WebAudio context from burning a battery in
      // a bag. The fixed-timestep loop caps its catch-up, so resuming does not
      // fast-forward the match.
      web.onPause();
      web.pauseTimers();
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (web != null) {
      web.resumeTimers();
      web.onResume();
    }
    goImmersive();
  }

  @Override
  protected void onDestroy() {
    if (web != null) {
      // Detach before destroy, or the WebView outlives the Activity holding a
      // reference to it and leaks the whole view tree.
      web.setWebChromeClient(null);
      ((android.view.ViewGroup) web.getParent()).removeView(web);
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }
}
