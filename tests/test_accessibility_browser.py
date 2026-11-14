"""Real-browser regression for vote/result semantics and the live voting chain.

Requires Playwright Chromium and running vote, custom-option vote, result and
worker services backed by a disposable Redis/PostgreSQL pair. No network or
score mocks are used. URLs and output directory are supplied by the caller.
"""
import json
import os
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


VOTE_URL = os.environ["VOTE_URL"]
CUSTOM_VOTE_URL = os.environ["CUSTOM_VOTE_URL"]
RESULT_URL = os.environ["RESULT_URL"]
OUTPUT = Path(os.environ["BROWSER_OUTPUT_DIR"])
OUTPUT.mkdir(parents=True, exist_ok=True)


def counts():
    with urlopen(RESULT_URL + "/api/results", timeout=5) as response:
        return json.load(response)


def semantics(page, title, heading):
    assert page.title() == title
    assert page.locator("html").get_attribute("lang") == "zh-CN"
    assert page.locator("main").count() == 1
    assert page.locator("h1").count() == 1
    assert page.locator("main h1").inner_text() == heading
    assert page.locator("h1").is_visible()
    session = page.context.new_cdp_session(page)
    nodes = session.send("Accessibility.getFullAXTree")["nodes"]
    mains = [node for node in nodes if node.get("role", {}).get("value") == "main" and not node.get("ignored")]
    headings = [node for node in nodes if node.get("role", {}).get("value") == "heading" and any(prop["name"] == "level" and prop["value"]["value"] == 1 for prop in node.get("properties", []))]
    assert len(mains) == len(headings) == 1
    assert headings[0]["name"]["value"] == heading
    by_id = {node["nodeId"]: node for node in nodes}
    parent = headings[0]
    while parent["nodeId"] != mains[0]["nodeId"]:
        parent = by_id[parent["parentId"]]
    session.detach()
    return {"language": "zh-CN", "main": 1, "heading_level": 1, "heading": heading}


def native_form(page):
    form = page.locator("main form")
    assert form.count() == 1
    assert form.get_attribute("method").upper() == "POST"
    assert form.get_attribute("action") == "/"
    for value in ("a", "b"):
        button = form.locator('button[name="vote"][value="' + value + '"]')
        assert button.count() == 1
        assert button.get_attribute("type") == "submit"
        assert button.is_enabled()


def wait_result(page, expected):
    page.wait_for_function("expected => document.querySelector('#count-a').textContent.trim() === String(expected.a) && document.querySelector('#count-b').textContent.trim() === String(expected.b) && document.querySelector('#total-count').textContent.trim() === String(expected.a + expected.b)", arg=expected, timeout=20000)
    assert counts() == expected
    total = expected["a"] + expected["b"]
    for value in ("a", "b"):
        percent = 50 if total == 0 else expected[value] * 100 / total
        text = page.locator(".choice." + ("cats" if value == "a" else "dogs") + " .stat").inner_text()
        assert abs(float(text.rstrip("%")) - percent) <= 0.051, text


def main():
    report = {"baseline": counts(), "semantics": {}, "posts": []}
    frames = []
    errors = []
    navigations = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        result_context = browser.new_context(viewport={"width": 1280, "height": 900})
        result = result_context.new_page()
        result.on("pageerror", lambda error: errors.append(str(error)))
        result.on("framenavigated", lambda frame: navigations.append(frame.url) if frame == result.main_frame else None)
        result.on("websocket", lambda socket: socket.on("framereceived", lambda payload: frames.append(payload)))
        result.goto(RESULT_URL, wait_until="networkidle")
        wait_result(result, report["baseline"])
        report["semantics"]["result"] = semantics(result, "猫派 vs 狗派 -- Result", "实时投票结果")
        for selector in ("#count-a", "#count-b", "#total-count", "#total-label"):
            assert result.locator("main " + selector).count() == 1
            assert result.locator(selector).is_visible()

        mouse_context = browser.new_context(viewport={"width": 1280, "height": 900})
        mouse = mouse_context.new_page()
        mouse.on("request", lambda request: report["posts"].append(request.post_data) if request.method == "POST" else None)
        mouse.goto(VOTE_URL, wait_until="networkidle")
        report["semantics"]["vote"] = semantics(mouse, "猫派 vs 狗派!", "猫派 vs 狗派!")
        native_form(mouse)
        with mouse.expect_navigation():
            mouse.locator('button[value="a"]').click()
        assert mouse.locator("#vote-confirmation").inner_text() == "你已投给猫派"
        assert mouse.locator("#vote-confirmation").is_visible()
        a_expected = {"a": report["baseline"]["a"] + 1, "b": report["baseline"]["b"]}
        wait_result(result, a_expected)
        mouse.screenshot(path=str(OUTPUT / "vote-mouse.png"), full_page=True)
        # A refresh must read the persisted cookie confirmation, not resubmit POST.
        mouse.goto(VOTE_URL, wait_until="networkidle")
        assert mouse.locator("#vote-confirmation").inner_text() == "你已投给猫派"

        keyboard_context = browser.new_context(viewport={"width": 1280, "height": 900})
        keyboard = keyboard_context.new_page()
        keyboard.on("request", lambda request: report["posts"].append(request.post_data) if request.method == "POST" else None)
        keyboard.goto(VOTE_URL, wait_until="networkidle")
        native_form(keyboard)
        keyboard.keyboard.press("Tab")
        assert keyboard.locator(":focus").get_attribute("value") == "a"
        keyboard.keyboard.press("Tab")
        assert keyboard.locator(":focus").get_attribute("value") == "b"
        with keyboard.expect_navigation():
            keyboard.keyboard.press("Enter")
        assert keyboard.locator("#vote-confirmation").inner_text() == "你已投给狗派"
        final = {"a": a_expected["a"], "b": a_expected["b"] + 1}
        wait_result(result, final)
        keyboard.screenshot(path=str(OUTPUT / "vote-keyboard.png"), full_page=True)
        keyboard.goto(VOTE_URL, wait_until="networkidle")
        assert keyboard.locator("#vote-confirmation").inner_text() == "你已投给狗派"
        assert report["posts"] == ["vote=a", "vote=b"], report["posts"]
        cookies_a = {cookie["name"]: cookie["value"] for cookie in mouse_context.cookies()}
        cookies_b = {cookie["name"]: cookie["value"] for cookie in keyboard_context.cookies()}
        assert cookies_a["voter_id"] != cookies_b["voter_id"]
        assert len(navigations) == 1, navigations
        assert any(isinstance(frame, str) and '"scores"' in frame for frame in frames), frames
        assert not errors, errors
        report["final"] = final
        report["result_navigations"] = len(navigations)
        report["scores_frames"] = sum(isinstance(frame, str) and '"scores"' in frame for frame in frames)
        result.screenshot(path=str(OUTPUT / "result-live.png"), full_page=True)
        result.reload(wait_until="networkidle")
        wait_result(result, final)

        custom = browser.new_page(viewport={"width": 1280, "height": 900})
        custom.goto(CUSTOM_VOTE_URL, wait_until="networkidle")
        report["semantics"]["custom_vote"] = semantics(custom, "红茶派 vs 绿茶派!", "红茶派 vs 绿茶派!")
        native_form(custom)
        assert custom.locator('button[value="a"]').inner_text() == "红茶派"
        assert custom.locator('button[value="b"]').inner_text() == "绿茶派"
        custom.screenshot(path=str(OUTPUT / "vote-custom.png"), full_page=True)
        browser.close()
    (OUTPUT / "browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("PASS: Chromium DOM/AX semantics, native mouse/Tab+Enter POSTs, persisted confirmations, real scores updates, API counts and refresh readback")


if __name__ == "__main__":
    main()
