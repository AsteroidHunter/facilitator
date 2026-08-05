// READ-ONLY page health probe + create/delete round-trip (no messages sent)
const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
  });
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto("http://127.0.0.1:8877", { waitUntil: "networkidle2", timeout: 15000 });
  await new Promise(r => setTimeout(r, 2600));

  const before = await page.evaluate(() => ({
    boxes: document.querySelectorAll(".box").length,
    groups: document.querySelectorAll(".toc-group").length,
    addBtn: !!document.querySelector(".addbtn"),
    metaFirst: document.querySelector("#sections .bucket")?.textContent.includes("Meta"),
  }));

  // create a box via the API, wait for the auto-reload, check it renders with an x
  await page.evaluate(() => fetch("/create", { method: "POST", body: "__probe box__" }));
  await new Promise(r => setTimeout(r, 3000));
  const created = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".box")].find(b => b.textContent.includes("__probe box__"));
    return { found: !!el, hasX: !!el?.querySelector(".xbtn"), id: el?.id };
  });

  // delete it again via its x endpoint
  const delId = created.id?.replace("box-", "");
  await page.evaluate(id => fetch("/delete?box=" + id, { method: "POST" }), delId);
  await new Promise(r => setTimeout(r, 2000));
  const after = await page.evaluate(() => ({
    boxes: document.querySelectorAll(".box").length,
    probeGone: ![...document.querySelectorAll(".box")].some(b => b.textContent.includes("__probe box__")),
  }));

  console.log(JSON.stringify({ before, created, after, pageErrors: errs }, null, 1));
  await browser.close();
})();
