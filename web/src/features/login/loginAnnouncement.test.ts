import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../../app/login/page.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/login/login.css", import.meta.url), "utf8");

describe("versioned login announcement", () => {
  it("separates session close from permanent dismissal", () => {
    expect(page).toContain('LOGIN_ANNOUNCEMENT_ID = "2026-10-v0.6.7-logs-dns-twitter"');
    expect(page).toContain("window.sessionStorage.setItem(LOGIN_ANNOUNCEMENT_SESSION_KEY, \"1\")");
    expect(page).toContain("window.localStorage.setItem(LOGIN_ANNOUNCEMENT_HIDDEN_KEY, \"1\")");
    expect(page).toContain("不再显示");
    expect(page).toContain('aria-label="关闭本次更新公告"');
    expect(page).toContain('className="msf-login-announcement"');
    expect(page).not.toContain("msf-login-announcement gary-glass");
  });

  it("contains the requested release notes and responsive bubble layout", () => {
    expect(page).toContain("v0.6.7：日志搜索、DNS 学习与 X/Twitter");
    expect(page).toContain("日志搜索与实时更新");
    expect(page).toContain("MosDNS 学习按有效地址和明确规则判断");
    expect(page).toContain("Grok 继续优先走 AI");
    expect(page).toContain("DNS 服务可能短暂重启");
    expect(page).toContain("升级提示");
    expect(styles).toContain(".msf-login-announcement");
    expect(styles).toContain("position: fixed");
    expect(styles).toContain("height: auto");
    expect(styles).toContain("max-height: min(18rem, calc(100dvh - 2rem))");
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(styles).toContain("grid-template-columns: 1fr");
  });

  it("pairs the new announcement with a bilingual versioned changelog", () => {
    const changelog = readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");
    const release = changelog.split("## v0.6.7 - 2026-10-11")[1]?.split("\n## v")[0];
    expect(release).toBeTruthy();
    expect(release).toContain("### 中文");
    expect(release).toContain("### English");
    expect(release).toContain("Log search and live updates");
    expect(release).toContain("MosDNS learning and cache safety");
    expect(release).toContain("Default X/Twitter routing");
    expect(release).toContain("sh06y");
    expect(release).toContain("升级注意事项");
    expect(release).toContain("Upgrade notes");
    expect(page).not.toContain("2026-10-v0.6.6-cli-proxy-dns");
  });
});
