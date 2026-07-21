/* 验证 DeepSeek-GUI 前端 + Rcode 后端的核心链路 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // 处理目录选择的 prompt dialog
  page.on('dialog', async (dialog) => {
    await dialog.accept('/Users/a1412/Desktop/Rcode');
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(3500);

  // 1. 点击"选择工作目录"
  const pickBtn = page.locator('button:has-text("选择工作目录")').first();
  if (await pickBtn.count() > 0) {
    await pickBtn.click();
    console.log('clicked 选择工作目录');
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/step1-workspace.png' });

  // 2. 点击"新建智能体"创建会话
  const newBtn = page.locator('button:has-text("新建智能体")').first();
  if (await newBtn.count() > 0) {
    await newBtn.click();
    console.log('clicked 新建智能体');
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/step2-newthread.png' });

  // 3. 输入消息并发送
  const textarea = page.locator('textarea').first();
  await textarea.click();
  await textarea.fill('你好，请用一句话介绍你自己。');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  console.log('message sent');

  // 4. 等待流式回复
  await page.waitForTimeout(4000);
  await page.screenshot({ path: '/tmp/step3-streaming.png' });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: '/tmp/step4-final.png' });

  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
