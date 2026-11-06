"""Local, headless Chromium QA for the harmonica prototype.

Set HA_APP_URL to a running local server, optionally HA_QA_OUTPUT and
HA_CHROMIUM. Set HA_STANDALONE to check a built HTML via file:// without
network access. Requires Python Playwright and Pillow.
"""

import asyncio
import json
import os
import re
from pathlib import Path
import shutil
import sys

from PIL import Image, ImageChops
from playwright.async_api import async_playwright, expect


APP_URL = os.environ.get("HA_APP_URL", "http://127.0.0.1:4173")
OUTPUT = Path(os.environ.get("HA_QA_OUTPUT", "qa-output")).resolve()
CHROMIUM = os.environ.get("HA_CHROMIUM") or shutil.which("chromium")
STANDALONE = os.environ.get("HA_STANDALONE")
PRESETS = ("front", "back", "left", "right")
MODELS = {"diatonic": "compact-study", "chromatic": "slide-study"}


async def wait_ready(page, category="diatonic"):
    await expect(page.locator("#app")).to_have_attribute("data-load", "ready")
    await expect(page.locator("#app")).to_have_attribute("data-model", MODELS[category])
    await expect(page.locator(f'[data-category="{category}"]')).to_have_attribute(
        "aria-pressed", "true"
    )


async def select_model(page, category):
    await page.locator(f'[data-category="{category}"]').click()
    await wait_ready(page, category)


async def select_position(page):
    select = page.locator("#position")
    positions = await select.locator("option").evaluate_all(
        "(options) => options.map(o => o.value).filter(Boolean)"
    )
    assert positions, "model has no selectable demonstration position"
    await select.select_option(positions[len(positions) // 2])
    return await select.input_value()


async def set_transparency(page, value):
    slider = page.locator("#transparency")
    await slider.evaluate(
        """(el, value) => {
          el.value = String(value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        value,
    )
    await expect(page.locator("#transparency-value")).to_contain_text(f"{value}%")


async def set_view(page, direction):
    button = page.locator(f'[data-view="{direction}"]')
    await button.click()
    await expect(page.locator("#app")).to_have_attribute("data-view", direction)
    await expect(button).to_have_attribute("aria-pressed", "true")


async def show(page):
    await page.goto(APP_URL, wait_until="domcontentloaded")
    await wait_ready(page)
    await expect(page.locator("#viewer")).to_be_visible()
    await expect(page.locator("#fallback")).to_be_hidden()


def visual_difference(first, second):
    with Image.open(first) as first_image, Image.open(second) as second_image:
        width, height = first_image.size
        assert second_image.size == first_image.size
        crop = (int(width * .12), int(height * .17), int(width * .88), int(height * .83))
        pixels_a = first_image.convert("RGB").crop(crop)
        pixels_b = second_image.convert("RGB").crop(crop)
        difference = ImageChops.difference(pixels_a, pixels_b).convert("L")
        changed = sum(difference.histogram()[12:])
        return changed / (difference.width * difference.height)


async def matrix(page, device):
    await show(page)
    frames = {}
    for category in MODELS:
        await select_model(page, category)
        await select_position(page)
        for direction in PRESETS:
            await set_view(page, direction)
            for value in (0, 50, 100):
                await set_transparency(page, value)
                await page.wait_for_timeout(80)
                target = OUTPUT / f"matrix-{device}-{category}-{direction}-{value:03}.png"
                await page.locator("#stage").screenshot(path=target)
                frames[category, direction, value] = target
    for category in MODELS:
        for direction in PRESETS:
            delta = visual_difference(frames[category, direction, 0], frames[category, direction, 100])
            assert delta > .01, f"{category} {direction}: rendered opacity delta {delta:.4f}"
    for direction in PRESETS:
        delta = visual_difference(frames["diatonic", direction, 100], frames["chromatic", direction, 100])
        assert delta > .005, f"{direction}: rendered model delta {delta:.4f}"
    await select_model(page, "diatonic")
    await select_position(page)
    await set_view(page, "right")
    await set_transparency(page, 60)
    await page.locator("#breath-blow").click()
    await page.screenshot(path=OUTPUT / f"overview-{device}.png", full_page=True)
    return "장면 캡처 24장, 중앙 장면 픽셀 비교로 0→100% 및 모델 전환의 실제 화면 차이 확인"


async def continuity(page):
    await show(page)
    position = await select_position(page)
    await set_transparency(page, 47)
    await page.locator("#breath-draw").click()

    async def check():
        assert await page.locator("#position").input_value() == position
        assert await page.locator("#transparency").input_value() == "47"
        await expect(page.locator("#breath-draw")).to_have_attribute("aria-pressed", "true")
        await expect(page.locator("#state-summary")).to_contain_text("47%")
        await expect(page.locator("#app")).to_have_attribute("data-model", "compact-study")

    for direction in PRESETS:
        await set_view(page, direction)
        await check()
    canvas = page.locator("#viewer")
    box = await canvas.bounding_box()
    assert box, "viewer has no bounding box"
    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    await page.mouse.down()
    await page.mouse.move(box["x"] + box["width"] * 0.65, box["y"] + box["height"] * 0.36, steps=7)
    await page.mouse.up()
    await expect(page.locator("#app")).to_have_attribute("data-view", "free")
    await check()
    await page.locator("#stage").screenshot(path=OUTPUT / "oblique-drag.png")
    await page.set_viewport_size({"width": 1000, "height": 700})
    await check()
    return "시점 네 번, 드래그, 리사이즈 뒤 위치·들숨·47% 유지"


async def race_and_recovery(page):
    counts = {"compact": 0, "slide": 0}
    phase = "normal"

    async def model_route(route):
        chromatic = "slide-study.json" in route.request.url
        key = "slide" if chromatic else "compact"
        counts[key] += 1
        if phase == "fail" and chromatic:
            await route.fulfill(status=503, body="offline fixture")
            return
        if phase == "invalid" and chromatic:
            await route.fulfill(status=200, content_type="application/json", body="{")
            return
        if phase == "race":
            await asyncio.sleep(0.35 if chromatic else 0.07)
        try:
            await route.continue_()
        except Exception:
            if phase != "race":
                raise
            # The app can abort this deliberately delayed, superseded request.

    await page.route("**/models/*.json", model_route)
    await show(page)
    await select_position(page)
    await set_transparency(page, 42)
    phase = "race"
    await page.evaluate(
        """async () => {
          for (let index = 0; index < 30; index += 1) {
            const category = index % 2 === 0 ? 'chromatic' : 'diatonic';
            document.querySelector(`[data-category="${category}"]`).click();
            await new Promise(resolve => setTimeout(resolve, 12));
          }
        }"""
    )
    await wait_ready(page)
    await page.wait_for_timeout(430)
    await wait_ready(page)
    assert await page.locator("#transparency").input_value() == "42"
    phase = "fail"
    await page.locator('[data-category="chromatic"]').click()
    await expect(page.locator("#app")).to_have_attribute("data-load", "error")
    await expect(page.locator("#model-retry")).to_be_visible()
    await expect(page.locator("#position")).to_be_disabled()
    await page.screenshot(path=OUTPUT / "error-model-load.png", full_page=True)
    phase = "invalid"
    await page.locator("#model-retry").click()
    await expect(page.locator("#app")).to_have_attribute("data-load", "error")
    phase = "normal"
    await page.locator("#model-retry").click()
    await wait_ready(page, "chromatic")
    assert await page.locator("#transparency").input_value() == "42"
    assert counts["slide"] >= 3
    return f"종류 버튼 30회, HTTP 503·JSON 파싱 오류·재시도 및 최신 선택 확인 ({counts})"


async def mobile_inputs(page, context):
    await show(page)
    await set_view(page, "front")
    canvas = page.locator("#viewer")
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    await canvas.scroll_into_view_if_needed()
    box = await canvas.bounding_box()
    assert box
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    cdp = await context.new_cdp_session(page)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for delta in (10, 20, 32, 50):
        await cdp.send("Input.dispatchTouchEvent", {
            "type": "touchMove", "touchPoints": [{"x": x + delta, "y": y - delta / 2}],
        })
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await expect(page.locator("#app")).to_have_attribute("data-view", "free")
    await set_view(page, "right")
    slider = page.locator("#transparency")
    await slider.scroll_into_view_if_needed()
    slider_box = await slider.bounding_box()
    assert slider_box
    await page.touchscreen.tap(
        slider_box["x"] + slider_box["width"] * 0.74,
        slider_box["y"] + slider_box["height"] / 2,
    )
    assert await slider.input_value() != "60"
    await expect(page.locator("#app")).to_have_attribute("data-view", "right")
    await page.set_viewport_size({"width": 780, "height": 360})
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    await expect(slider).to_be_visible()
    await page.screenshot(path=OUTPUT / "overview-mobile-landscape.png", full_page=True)
    await page.set_viewport_size({"width": 320, "height": 650})
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    await expect(slider).to_be_visible()
    return "360px 터치 회전·슬라이더 분리, 780×360 가로, 320px 가로 넘침 확인"


async def keyboard_and_semantics(page):
    await show(page)
    await page.keyboard.press("Tab")
    assert await page.evaluate(
        "() => document.activeElement && document.activeElement !== document.body"
    )
    await page.locator('[data-category="chromatic"]').focus()
    await page.keyboard.press("Space")
    await wait_ready(page, "chromatic")
    right = page.locator('[data-view="right"]')
    await right.focus()
    await page.keyboard.press("Enter")
    await expect(page.locator("#app")).to_have_attribute("data-view", "right")
    await page.locator("#viewer").focus()
    await page.keyboard.press("ArrowLeft")
    await expect(page.locator("#app")).to_have_attribute("data-view", "free")
    await right.focus()
    await page.keyboard.press("Space")
    await expect(page.locator("#app")).to_have_attribute("data-view", "right")
    slider = page.locator("#transparency")
    await slider.focus()
    await page.keyboard.press("Home")
    assert await slider.input_value() == "0"
    await page.keyboard.press("End")
    assert await slider.input_value() == "100"
    await page.keyboard.press("ArrowLeft")
    assert int(await slider.input_value()) < 100
    await expect(page.locator("#app")).to_have_attribute("data-view", "right")
    select = page.locator("#position")
    await select.focus()
    await page.keyboard.press("Home")
    await page.keyboard.press("ArrowDown")
    assert await select.input_value()
    blow = page.locator("#breath-blow")
    await blow.focus()
    await page.keyboard.press("Space")
    await expect(blow).to_have_attribute("aria-pressed", "true")
    await expect(page.locator("#note-label")).to_contain_text(re.compile("검증|설정"))
    await expect(page.locator("#learning-result")).to_contain_text(re.compile("검증|기구 상태"))
    await expect(page.locator("#state-summary")).to_contain_text("날숨")
    snapshot = await page.locator("#app").aria_snapshot()
    assert "slider" in snapshot and "얼굴 투명도" in snapshot
    assert "정면" in snapshot and "날숨" in snapshot
    (OUTPUT / "accessibility-tree.txt").write_text(snapshot, encoding="utf-8")
    return "키보드 악기→시점→자유회전→투명도→위치→날숨, 접근성 트리 이름·상태"


async def webgl_fallback(page, context):
    await page.add_init_script(
        """() => {
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(kind, options) {
            if (/^(experimental-)?webgl2?$/.test(kind)) return null;
            return original.call(this, kind, options);
          };
        }"""
    )
    await page.goto(APP_URL, wait_until="domcontentloaded")
    await wait_ready(page)
    await expect(page.locator("#fallback")).to_be_visible()
    await select_position(page)
    await page.locator("#breath-draw").click()
    await expect(page.locator("#state-summary")).to_contain_text("들숨")
    await page.screenshot(path=OUTPUT / "error-webgl-unavailable.png", full_page=True)

    actual = await context.new_page()
    await show(actual)
    outcome = await actual.locator("#viewer").evaluate(
        """canvas => {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const extension = gl?.getExtension('WEBGL_lose_context');
          if (!extension) return false;
          window.haLostContext = extension;
          extension.loseContext();
          return true;
        }"""
    )
    assert outcome, "WEBGL_lose_context extension is unavailable"
    await expect(actual.locator("#fallback")).to_be_visible()
    await actual.evaluate("window.haLostContext.restoreContext()")
    await expect(actual.locator("#fallback")).to_be_hidden()
    await actual.close()
    return "WebGL 미지원에서 텍스트 조작 유지, WEBGL_lose_context 손실·복구"



async def standalone_smoke(page, context):
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    await page.goto(Path(STANDALONE).resolve().as_uri(), wait_until="domcontentloaded")
    await wait_ready(page)
    await expect(page.locator("#fallback")).to_be_hidden()
    await set_view(page, "right")
    await select_position(page)
    await set_transparency(page, 100)
    first = OUTPUT / "offline-compact.png"
    await page.locator("#stage").screenshot(path=first)
    await select_model(page, "chromatic")
    await select_position(page)
    await expect(page.locator("#transparency-value")).to_contain_text("100%")
    await page.locator("#breath-draw").click()
    await expect(page.locator("#state-summary")).to_contain_text("들숨")
    second = OUTPUT / "offline-slide.png"
    await page.locator("#stage").screenshot(path=second)
    assert visual_difference(first, second) > .005, "offline model change produced no visible geometry change"
    assert not [url for url in requests if url.startswith(("http:", "https:"))], requests
    return "네트워크 오프라인 file:// 실행, 두 형상과 학습 조작, HTTP(S) 요청 없음"


async def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=CHROMIUM)
        desktop = {"viewport": {"width": 1440, "height": 960}, "reduced_motion": "reduce"}
        desktop_motion = {**desktop, "reduced_motion": "no-preference"}
        mobile = {
            "viewport": {"width": 360, "height": 780}, "device_scale_factor": 2,
            "is_mobile": True, "has_touch": True, "reduced_motion": "reduce",
        }
        cases = [
            ("V01-Desktop", desktop, lambda page, _: matrix(page, "desktop")),
            ("V01-Mobile", mobile, lambda page, _: matrix(page, "mobile")),
            ("V02", desktop_motion, lambda page, _: continuity(page)),
            ("V03/V06-Model", desktop, lambda page, _: race_and_recovery(page)),
            ("T09/V04", mobile, mobile_inputs),
            ("T10/V05", desktop, lambda page, _: keyboard_and_semantics(page)),
            ("V06-WebGL", desktop, webgl_fallback),
        ]
        if STANDALONE:
            cases.append(("Standalone", {**desktop, "offline": True}, standalone_smoke))
        for name, config, run in cases:
            context = await browser.new_context(**config)
            page = await context.new_page()
            page.set_default_timeout(7000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                details = await run(page, context)
                assert not errors, errors
                record = {"id": name, "status": "통과", "detail": details}
            except Exception as error:
                await page.screenshot(
                    path=OUTPUT / f"failure-{name.replace('/', '-')}.png", full_page=True
                )
                record = {"id": name, "status": "실패", "detail": str(error) or repr(error)}
            await context.close()
            records.append(record)
            print(f"{name} {record['status']} {record['detail']}", flush=True)
        report = {
            "browser": f"Chromium {browser.version}",
            "browser_mode": "headless",
            "automation": "Python Playwright, assertions + stage screenshot differences",
            "desktop": desktop,
            "mobile_emulation": mobile,
            "manual_visual_review": "separate from this automated report",
            "cases": records,
        }
        (OUTPUT / "browser-results.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        await browser.close()
    return any(record["status"] == "실패" for record in records)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
