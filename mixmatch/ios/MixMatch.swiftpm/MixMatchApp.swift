import SwiftUI

/*
 * Mix & Match on iPad — a test build.
 *
 * One screen: the Timer tab. That is deliberate. The point of this build is to
 * find out what the round clock and the arcade feel like under a thumb on real
 * glass, and every extra screen is a thing that has to work before you can
 * answer that question.
 *
 * WHAT IS NOT HERE, AND WHY
 *
 * No purchases. Apple requires in-app purchase for digital content, so the $15
 * token pack and the $5/mo subscription have to go through StoreKit on iOS —
 * they cannot open a Stripe page. That is a real piece of work (products in App
 * Store Connect, a StoreKit 2 flow, receipt verification on the server before
 * granting credit) and it should not be bolted on before anyone has decided the
 * app is worth shipping. MixMatchKit already carries the `apple_iap` rail and
 * the net-per-rail arithmetic for when it is.
 *
 * No account. Nothing here needs one yet: the Timer tab keeps its preferences
 * in the page's own storage and spends nothing.
 */

@main
struct MixMatchApp: App {
    var body: some Scene {
        WindowGroup {
            WebHost()
                .ignoresSafeArea(.keyboard)
                .background(Color(red: 0.14, green: 0.12, blue: 0.10))
                .preferredColorScheme(.dark)
        }
    }
}
