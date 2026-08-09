import SwiftUI
import WebKit

/*
 * The web host.
 *
 * WHY A WEBVIEW AND NOT A SWIFTUI REWRITE
 *
 * The same reason rocketman/android is a WebView: the expensive part is already
 * written, tested and shipping. mixmatch/web/timer-engine.js has 48 tests
 * behind it, including a heuristic player that proves the game's balance.
 * Rewriting the round clock and the arcade in SwiftUI would mean maintaining
 * the rules twice and diffing them forever — a real project, and one this app
 * does not need in order to be on an iPad this afternoon.
 *
 * MixMatchKit (../../swift) exists for the parts that genuinely must be native:
 * the token arithmetic behind an eventual StoreKit purchase. Logic that decides
 * what a customer is charged does not belong in a web page inside a wrapper.
 *
 * WHY A CUSTOM URL SCHEME AND NOT loadFileURL
 *
 * A file:// page in WKWebView gets an opaque origin, and an opaque origin has
 * no reliable localStorage. The Timer tab stores your preset, your sound
 * preference and your best score there. Registering a scheme handler gives the
 * page a real, stable origin, so those persist across launches.
 *
 * This is the same problem GameAssetServer.java solves on Fire OS by running a
 * loopback HTTP server. WebKit offers a first-class answer, so there is no
 * socket here and nothing listening on a port.
 */

/// The origin the app content is served from. Anything but `file:`.
private let appScheme = "mixmatch"
private let appHost = "app"

/// Serves the bundled page to the WebView.
///
/// Only ever answers for resources compiled into the app, and only for names
/// with no path separators in them — a scheme handler that will hand back
/// whatever path it is asked for is a directory-traversal bug waiting for
/// someone to inject a URL into the page.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {

    private static let types = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        var name = url.lastPathComponent
        if name.isEmpty || name == "/" { name = "index.html" }

        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension

        guard
            !base.isEmpty,
            !base.contains("/"),
            !base.contains(".."),
            let fileURL = Bundle.main.url(forResource: base, withExtension: ext),
            let data = try? Data(contentsOf: fileURL)
        else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": Self.types[ext] ?? "application/octet-stream",
                "Content-Length": String(data.count),
                // The page is entirely local and talks to nothing. Saying so
                // means a future edit that adds a stray external script fails
                // loudly here rather than shipping a silent network call.
                "Content-Security-Policy":
                    "default-src 'self' \(appScheme):; script-src 'self' 'unsafe-inline' \(appScheme):; "
                    + "style-src 'self' 'unsafe-inline' \(appScheme):; connect-src 'none'",
            ]
        )!

        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

struct WebHost: UIViewRepresentable {

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: appScheme)

        // The game is a canvas that reacts to a held finger. Letting the OS
        // decide a drag was a scroll or a text selection makes it unplayable.
        config.allowsInlineMediaPlayback = true
        config.suppressesIncrementalRendering = false

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.14, green: 0.12, blue: 0.10, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        #if DEBUG
        // Safari on a Mac can then inspect this — the only piece of the loop
        // that still wants one, and only for debugging.
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        webView.load(URLRequest(url: URL(string: "\(appScheme)://\(appHost)/index.html")!))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
