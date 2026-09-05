const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../../../../..');
const source = fs.readFileSync(path.join(repo, 'web-client/js/input.test.js'), 'utf8');
const harness = { require, console, setTimeout, clearTimeout, __dirname: path.join(repo, 'web-client/js') };
vm.createContext(harness);
vm.runInContext(source.slice(0, source.indexOf("test('mobile viewer acceptance")) + '\nglobalThis.helpers = { loadInput, activate, loadTouchAdapter };', harness);
const {loadInput, activate, loadTouchAdapter} = harness.helpers;

// Real Input methods with isolated DOM/transport adapters; no live Host.
{
  const {Input, context, elements} = loadInput();
  activate(Input, context);
  Input.setupTextInput();
  const video = elements.get('remoteVideo');
  const text = elements.get('mobileTextInput');
  video.focus = () => { context.document.activeElement = video; };
  text.focus = () => { context.document.activeElement = text; };
  Input.mobileTextInputAdapter.show();
  assert.equal(context.document.activeElement, text);
  Input.setActive(true);
  assert.equal(context.document.activeElement, video);
  console.log('F1 confirmed: repeated active gate moves focus from mobile textarea to video');
}
{
  const {Input, context, elements, socketEvents} = loadInput();
  activate(Input, context);
  const button = {dataset: {mobileAction: 'left'}, disabled: false, addEventListener(_type, cb) { this.click = cb; }};
  context.document.querySelectorAll = selector => selector === '.action-btn, [data-mobile-action]' ? [button] : [];
  Input.setupTextInput();
  Input.setupActionButtons();
  const text = elements.get('mobileTextInput');
  const input = () => text.listeners.get('input')({target: text});
  text.value = 'abc'; input();
  const before = text.selectionStart;
  button.click({preventDefault() {}});
  const last = socketEvents.at(-1).payload;
  assert.equal(last.action, 'batch');
  assert.equal(last.payload.steps[0].code, 'ArrowLeft');
  assert.equal(text.selectionStart, before);
  text.value = 'abcX\u200b'; input();
  console.log('F3 confirmed: toolbar ArrowLeft reaches transport but local cursor stays at end; next X produces remote abXc vs local abcX');
}
{
  const {Input, context, elements, socketEvents} = loadInput();
  loadTouchAdapter(context);
  activate(Input, context);
  Input.bindTouchAdapter(elements.get('remoteVideo'));
  const video = elements.get('remoteVideo');
  const emit = (type, x) => video.listeners.get(type)({pointerType:'touch', isPrimary:true, pointerId:1, clientX:x, clientY:10, preventDefault(){}});
  emit('pointerdown', 10);
  emit('pointermove', 19);
  emit('pointerup', 30);
  const down = socketEvents.find(e=>e.payload.action==='down').payload;
  assert.equal(down.payload.relX, 0.19);
  console.log('F4 confirmed: drag down uses threshold-crossing point, not original contact point');
}
{
  const {MobileTextInput} = require(path.join(repo, 'web-client/js/mobile-text-input.js'));
  const listeners = new Map();
  let reject = false;
  let remote = '';
  const el = {value:'', selectionStart:0, selectionEnd:0, addEventListener(t,cb){listeners.set(t,cb)}, focus(){}, blur(){}};
  const adapter = MobileTextInput.create({element:el, isEnabled:()=>true, sendText:t=>{if(reject)return false;remote+=t;return true}, sendKey:()=>true});
  adapter.attach();
  el.value='a';listeners.get('input')();
  reject=true;el.value='ab\u200b';listeners.get('input')();
  let prevented=false;
  listeners.get('beforeinput')({target:el,inputType:'insertText',preventDefault(){prevented=true}});
  assert.equal(prevented,true);
  assert.equal(el.value,'a\u200b');
  assert.equal(remote,'a');
  console.log('F5 confirmed: next beforeinput after rejected send discards unsent draft via restoreBuffer');
}
