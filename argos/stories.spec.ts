import { argosScreenshot } from "@argos-ci/playwright";
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type StoryIndex = {
  entries: Record<string, { id: string; title: string; name: string; type: string }>;
};

type ChromaticParameters = {
  disableSnapshot?: boolean;
  delay?: number;
  viewports?: number[];
};

const indexPath = fileURLToPath(new URL("../storybook-static/index.json", import.meta.url));
const index: StoryIndex = JSON.parse(readFileSync(indexPath, "utf-8"));

// `ARGOS_ONLY=components-button--variants,...` narrows a local run to the
// stories being investigated instead of the whole index.
const only = process.env.ARGOS_ONLY?.split(",").map(s => s.trim());

const stories = Object.values(index.entries).filter(
  entry => entry.type === "story" && (!only || only.includes(entry.id))
);

const DEFAULT_VIEWPORT = { width: 1200, height: 800 };

for (const story of stories) {
  test(`${story.title} › ${story.name}`, async ({ page }) => {
    // `chromatic=true` is what `chromatic/isChromatic` looks for, so the
    // decorators in `src/utilities/chromatic-decorators.ts` (fullscreenLayout,
    // centeredLayout, extraPadding, withNoAnimation) apply here exactly as they
    // do in a Chromatic run.
    const storyUrl = `/iframe.html?id=${story.id}&viewMode=story&chromatic=true`;

    const readChromaticParameters = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __STORYBOOK_PREVIEW__?: {
                currentRender?: {
                  story?: { parameters?: { chromatic?: ChromaticParameters } };
                };
              };
            }
          ).__STORYBOOK_PREVIEW__?.currentRender?.story?.parameters?.chromatic ?? null
      );

    const waitForRender = async () => {
      // Some stories render into a portal (dialog, drawer, popover, tooltip)
      // and leave the Storybook root empty, so wait on the render phase rather
      // than on the root element.
      await page.waitForFunction(() => {
        const phase = (
          window as unknown as {
            __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } };
          }
        ).__STORYBOOK_PREVIEW__?.currentRender?.phase;

        return phase === "completed" || phase === "finished";
      });
    };

    await page.setViewportSize(DEFAULT_VIEWPORT);
    await page.goto(storyUrl);
    await waitForRender();

    const parameters = (await readChromaticParameters()) as ChromaticParameters | null;

    // Stories that opt out of snapshots today keep opting out.
    test.skip(
      parameters?.disableSnapshot === true,
      "story opts out of snapshots (chromatic parameter)"
    );

    // A story that pins its own `chromatic: { viewports: [...] }` is captured at
    // those widths and nowhere else, same as in the current runs.
    const viewports = parameters?.viewports?.length
      ? parameters.viewports
      : [DEFAULT_VIEWPORT.width];

    for (const width of viewports) {
      if (width !== DEFAULT_VIEWPORT.width || viewports.length > 1) {
        await page.setViewportSize({ width, height: DEFAULT_VIEWPORT.height });
        await page.goto(storyUrl);
        await waitForRender();
      }

      if (parameters?.delay) {
        await page.waitForTimeout(parameters.delay);
      }

      // Lit components size themselves from text metrics; wait for Rubik to
      // land, then nudge the viewport so any observer re-measures against the
      // final font.
      await page.evaluate(() => document.fonts.ready);
      await page.setViewportSize({ width: width + 1, height: DEFAULT_VIEWPORT.height });
      await page.setViewportSize({ width, height: DEFAULT_VIEWPORT.height });

      // Hold until the markup stops changing, capped so a story with a running
      // animation still gets captured. Three samples 250ms apart means 500ms of
      // quiet: the notification stories stagger their play function 300ms per
      // item, and a two-sample window fits between two arrivals.
      let previousMarkup = "";
      let stableSamples = 0;

      for (let i = 0; i < 40 && stableSamples < 3; i++) {
        // Every component here renders into a shadow root, and `innerHTML` stops
        // at the shadow boundary: `bl-icon` fetches its SVG at runtime, so an
        // icon can still be landing while the light DOM has looked settled for
        // a while. Walk the shadow roots too.
        const markup = await page.evaluate(() => {
          const serialize = (root: DocumentFragment | Element): string => {
            let out = root.innerHTML;

            for (const el of Array.from(root.querySelectorAll("*"))) {
              if (el.shadowRoot) {
                out += `<${el.tagName}>${serialize(el.shadowRoot)}`;
              }
            }

            return out;
          };

          return serialize(document.body);
        });

        stableSamples = markup === previousMarkup ? stableSamples + 1 : 0;
        previousMarkup = markup;
        if (stableSamples < 3) {
          await page.waitForTimeout(250);
        }
      }

      // Settled markup does not mean a settled picture: a notification slides in
      // over 0.3s and the stack repositions through an inline `transform`
      // transition, neither of which touches innerHTML. Let every animation that
      // has an end reach it, and leave the endless ones (spinners) alone.
      await page.evaluate(async () => {
        const finite = document.getAnimations().filter(animation => {
          const { endTime } = animation.effect?.getComputedTiming() ?? {};

          return (
            animation.playState === "running" &&
            typeof endTime === "number" &&
            Number.isFinite(endTime)
          );
        });

        await Promise.race([
          Promise.all(finite.map(animation => animation.finished.catch(() => undefined))),
          new Promise(resolve => setTimeout(resolve, 2000)),
        ]);
      });

      // Overflowing containers (tables, dropdown lists, tab bars) can settle on
      // an arbitrary offset: pin every scroll position before capturing.
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("*"))) {
          if (el.scrollLeft !== 0) el.scrollLeft = 0;
          if (el.scrollTop !== 0) el.scrollTop = 0;
        }
      });

      // Spinners and progress indicators are the point of some stories and stay
      // `aria-busy` for as long as they are mounted. Read that off the DOM
      // instead of guessing from the story name; the markup has already held
      // still above, so anything still busy is the intended state.
      const staysBusy = await page.evaluate(
        () => document.querySelector('[aria-busy="true"]') !== null
      );

      const name = viewports.length > 1 ? `${story.id}-${width}` : story.id;

      // Capture the body rather than the viewport: its box is exactly the
      // rendered story (64px tall for a row of buttons, 432px once a tooltip is
      // open), which both matches the crop the current runs produce and keeps a
      // small change from being diluted in 800px of empty canvas. Portals mount
      // into the body, so overlays stay in frame.
      await argosScreenshot(page, name, {
        element: "body",
        stabilize: { waitForAriaBusy: !staysBusy },
      });
    }
  });
}
