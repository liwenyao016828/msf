import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../../app/login/page.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/login/login.css", import.meta.url), "utf8");

describe("versioned login announcement", () => {
  it("separates session close from permanent dismissal", () => {
    expect(page).toContain('LOGIN_ANNOUNCEMENT_ID = "2026-10-v0.6.7.1-dns-safe-mode"');
    expect(page).toContain("window.sessionStorage.setItem(LOGIN_ANNOUNCEMENT_SESSION_KEY, \"1\")");
    expect(page).toContain("window.localStorage.setItem(LOGIN_ANNOUNCEMENT_HIDDEN_KEY, \"1\")");
    expect(page).toContain("不再显示");
    expect(page).toContain('aria-label="关闭本次更新公告"');
    expect(page).toContain('className="msf-login-announcement"');
    expect(page).not.toContain("msf-login-announcement gary-glass");
  });

  it("contains the requested release notes and responsive bubble layout", () => {
    expect(page).toContain("v0.6.7.1：DNS 安全模式修补");
    expect(page).toContain("失败处理与缓存恢复");
    expect(page).toContain("安全模式取消国内 DNS 回退");
    expect(page).toContain("刷新配置不再覆盖用户添加的广告与分流规则源");
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
    const release = changelog.split("## v0.6.7.1 - 2026-10-11")[1]?.split("\n## v")[0];
    expect(release).toBeTruthy();
    expect(release).toContain("### 中文");
    expect(release).toContain("### English");
    expect(release).toContain("MosDNS safe-mode fixes");
    expect(release).toContain("User rule-source preservation");
    expect(release).toContain("This release does not include a MosDNS core patch");
    expect(release).toContain("sh06y");
    expect(release).toContain("升级注意事项");
    expect(release).toContain("Upgrade notes");
    expect(page).not.toContain("2026-10-v0.6.7-logs-dns-twitter");
  });
});
