/**
 * Win32 层的安全验证脚本：**不发送任何键盘输入**。
 *
 * 只做三件无副作用的事：
 *   1. 检查结构体大小是否与 Windows 预期一致；
 *   2. 剪贴板写→读→还原 的往返（会临时改剪贴板，但会还原）；
 *   3. 只读地打印当前前台窗口的焦点信息。
 *
 * 用法：node scripts/verify-win32.cjs
 */
const win32 = require('../dist/main/win32.cjs');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`);
}

console.log('— 结构体布局 —');
// x64: INPUT = 40 字节；GUITHREADINFO = 72 字节
check('sizeof(INPUT)', win32.INPUT_SIZE, 40);
check('sizeof(GUITHREADINFO)', win32.GUITHREADINFO.size, 72);

console.log('\n— 剪贴板往返 —');
const original = win32.readClipboardText();
const sample = '轻语 QingYu 剪贴板往返测试 42';
const wrote = win32.writeClipboardText(sample);
check('写入剪贴板返回 true', wrote, true);
const readBack = win32.readClipboardText();
check('读回内容一致', readBack, sample);

// 还原用户原来的剪贴板（原来没有文本就清空）
if (original !== null) {
  win32.writeClipboardText(original);
  console.log('✅ 已还原原剪贴板内容');
} else {
  console.log('ℹ️ 原本剪贴板里没有文本，未还原');
}

console.log('\n— 前台窗口信息（只读）—');
const focus = win32.getFocusInfo();
if (focus) {
  console.log(`   前台句柄   = ${String(focus.hwnd)}`);
  console.log(`   线程 id    = ${focus.threadId}`);
  console.log(`   焦点控件   = ${String(focus.hwndFocus)}`);
  console.log(`   光标控件   = ${String(focus.hwndCaret)}`);
  console.log(`   有插入光标 = ${focus.hasCaret}`);
} else {
  console.log('   （没有前台窗口）');
}

console.log('\n— 按键状态（只读）—');
for (const [name, vk] of [['Ctrl', 0x11], ['Alt', 0x12], ['Shift', 0x10], ['V', 0x56]]) {
  console.log(`   ${name.padEnd(5)} = ${win32.isKeyDown(vk) ? '按下' : '未按下'}`);
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项不通过`}`);
process.exit(failures === 0 ? 0 : 1);
