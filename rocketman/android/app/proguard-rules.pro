# Minification is off for release (see app/build.gradle) — one Activity is not
# worth shrinking, and R8 cannot see through a WebView into the JavaScript that
# actually runs. This file exists so that turning it on later is a one-line
# change rather than a debugging session.

# The asset server is reached only from WebViewClient callbacks; keep it whole
# if shrinking is ever enabled.
-keep class com.negotiatorcruz.rocketman.GameAssetServer { *; }

# Anything reachable from JavaScript via addJavascriptInterface would need
# keeping here. Nothing is: the shell talks to the page through
# evaluateJavascript only, in one direction, which is the safer half of that
# bridge and the reason there is no @JavascriptInterface anywhere in this app.
