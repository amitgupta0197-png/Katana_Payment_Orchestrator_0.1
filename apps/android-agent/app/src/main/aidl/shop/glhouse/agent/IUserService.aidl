// Shizuku user service — runs inside a shell-UID process that Shizuku spawns, loading our
// own APK. Methods here execute at shell privilege, so `input tap` injected through it is
// treated by Paytm as a real finger touch (an AccessibilityService gesture is not).
package shop.glhouse.agent;

interface IUserService {
    // Shizuku's reserved transaction id used to tear the service process down.
    void destroy() = 16777114;

    // Run `sh -c <command>` at shell UID; returns combined stdout+stderr (empty on a
    // silent success like `input tap`). Prefixes "ERR:" if the process itself threw.
    String execute(String command) = 1;
}
