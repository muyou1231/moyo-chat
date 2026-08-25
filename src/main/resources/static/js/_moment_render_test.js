const fs = require('fs');
const vm = require('vm');

// ---- 最小前端环境 mock ----
let momentFeedCalled = false;
let momentMineCalled = false;
let momentGetSettingCalled = false;

function mockEl() {
  return {
    innerHTML: '',
    classList: { toggle() {}, add() {}, remove() {} },
    value: '',
  };
}

const sandbox = {
  window: {},
  document: {
    getElementById: () => mockEl(),
    querySelector: () => mockEl(),
  },
  App: {
    user: { id: 1, frozen: false },
    escapeHtml: (s) => (s == null ? '' : String(s)),
  },
  Api: {
    momentFeed() {
      momentFeedCalled = true;
      return Promise.resolve({ code: 0, data: [] });
    },
    momentMine() {
      momentMineCalled = true;
      return Promise.resolve({ code: 0, data: [] });
    },
    momentGetSetting() {
      momentGetSettingCalled = true;
      return Promise.resolve({ code: 0, data: { visibility: 'HALF_YEAR' } });
    },
  },
  console,
  Promise,
};
sandbox.window.App = sandbox.App;
sandbox.window.Api = sandbox.Api;

const code = fs.readFileSync('moment.js', 'utf8');
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'moment.js' });
} catch (e) {
  console.log('LOAD_ERROR:', e.message);
  process.exit(1);
}

const Moment = sandbox.window.Moment;
if (!Moment) {
  console.log('FAIL: window.Moment not defined');
  process.exit(1);
}

try {
  Moment.render();
} catch (e) {
  console.log('RENDER_THREW:', e.message);
  process.exit(1);
}

// 等微任务（render 内部是同步调用 loadFeed，loadFeed 调 Api.momentFeed 也是同步调用 Promise.resolve）
setTimeout(() => {
  console.log('momentFeedCalled =', momentFeedCalled);
  console.log('momentMineCalled =', momentMineCalled);
  console.log('momentGetSettingCalled =', momentGetSettingCalled);
  if (momentFeedCalled && momentGetSettingCalled) {
    console.log('PASS: render() 未抛异常，且成功发出了广场 feed 与设置请求');
  } else {
    console.log('FAIL: 未发出预期请求');
  }
}, 50);
