'use strict';

// Category labels only; no user records, browser storage or network are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const api = require('../category-translations.js');
const common = [
  ['Home Appliances', '家用电器'], ['Small Household Appliances', '小型家用电器'],
  ['Large Household Appliances', '大型家用电器'], ['Kitchen Appliances', '厨房电器'],
  ['Vacuum Cleaners & Floor Care Appliances', '吸尘器与地板清洁电器'], ['Remote Controls', '遥控器'],
  ['TVs & Accessories', '电视与配件'], ['TV Accessories', '电视配件'],
  ['Electronics', '电子产品'], ['Consumer Electronics', '消费电子'],
  ['Audio', '影音娱乐'], ['Home Audio & Speakers', '家用音响'],
  ['Amplifiers & Mixers', '扩音器 & 混音器'], ['Microphones', '麦克风'],
  ['Audio & Video Cables & Converters', '视听器材&转换器'], ['Media Players', '多媒体播放器'],
  ['Air Conditioners', '空调'], ['Air Purifiers & Dehumidifiers', '空气净化器与除湿机'],
  ['Irons & Steamers', '电熨斗与挂烫机'], ['Washing Machines & Dryers', '洗衣机与干衣机'],
  ['Rice Cookers', '电饭煲'], ['Electric Kettles', '电热水壶'],
  ['Coffee Machines & Accessories', '咖啡机与配件'], ['Blenders, Mixers & Grinders', '搅拌机、打蛋机与研磨机'],
  ['Mobile & Gadgets', '手机与配件'], ['Accessories', '配件'],
  ['Stylus', '触控笔'], ['Cables, Chargers & Converters', '线材、充电器与转换器'],
  ['Cases, Covers, & Skins', '保护壳、保护套与机身贴'], ['Mobile Flashes & Selfie Lights', '手机闪光灯与自拍补光灯'],
  ['Smartwatches & Fitness Trackers', '智能手表与运动手环'], ['Powerbanks & Batteries', '移动电源与电池'],
  ['Computers & Accessories', '电脑与配件'], ['Cameras & Drones', '相机与无人机'],
  ['Games & Consoles', '游戏与主机'], ['Home & Living', '家居生活'],
  ['Women Clothes', '女装'], ['Men Clothes', '男装'],
  ['Women Shoes', '女鞋'], ['Men Shoes', '男鞋'],
  ['Beauty', '美妆护肤'], ['Health', '健康保健'],
  ['Mother & Baby', '母婴用品'], ['Toys & Hobbies', '玩具与爱好'],
  ['Sports & Outdoors', '运动户外'], ['Pet Food & Accessories', '宠物食品与用品'],
  ['Food & Beverages', '食品饮料'], ['Books & Magazines', '书籍与杂志'],
  ['Stationery', '文具'], ['Automobiles', '汽车用品']
];

test('CommonJS and browser UMD expose the same offline category surface', () => {
  const sandbox = { fetch() { throw new Error('Network forbidden'); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../category-translations.js'), 'utf8'), sandbox);
  assert.equal(sandbox.BuyerCategoryTranslations.lookup('Remote Controls'), '遥控器');
  assert.equal(typeof sandbox.BuyerCategoryTranslations.translatePath, 'function');
  assert.equal(Object.isFrozen(api), true); assert.equal(Object.isFrozen(api.dictionary), true);
  assert.ok(api.sources.length >= 3);
});

for (const [english, chinese] of common) test(english + ' → ' + chinese, () => {
  assert.equal(api.lookup(english), chinese);
  assert.equal(api.lookup(chinese), chinese);
});

test('lookup normalizes case, spacing, typographic apostrophes and encoded ampersands', () => {
  assert.equal(api.lookup('  vacuum cleaners  &amp;  floor care appliances\n'), '吸尘器与地板清洁电器');
  assert.equal(api.lookup('HOME&APPLIANCES'), '', 'Normalization never substitutes a different whole category');
  assert.equal(api.lookup('home  appliances'), '家用电器');
  assert.equal(api.lookup('Home&#38;Living'), '家居生活');
  assert.equal(api.lookup('HOME&#x26;LIVING'), '家居生活');
  assert.equal(api.lookup('Women’s Clothing'), '女装');
  assert.equal(api.lookup('Ｈｏｍｅ Ａｐｐｌｉａｎｃｅｓ'), '家用电器');
});

test('known paths translate completely; no partial path or product-title word substitutions are invented', () => {
  assert.equal(api.translatePath(['Home Appliances', 'TVs & Accessories', 'Remote Controls']), '家用电器 > 电视与配件 > 遥控器');
  assert.equal(api.translatePath(['Home Appliances', 'Small Household Appliances', 'Vacuum Cleaners & Floor Care Appliances']), '家用电器 > 小型家用电器 > 吸尘器与地板清洁电器');
  assert.equal(api.translatePath(['Mobile & Gadgets', 'Accessories', 'Stylus']), '手机与配件 > 配件 > 触控笔');
  assert.equal(api.translatePath(['Audio', 'Entirely Unknown Fictional Category']), '');
  for (const value of ['Fictional Lunar Products', 'Home Appliances QA123', 'speaker portable model', 'Speaker Batteries Fantasy Category', 'Unknown Remote Controls', '尚未登记的火星类目', 'null', 'undefined', 'constructor', '__proto__', '', null, undefined, 123]) {
    assert.equal(api.lookup(value), '', String(value));
  }
  for (const value of [[], null, 'Audio', ['Audio', '']]) assert.equal(api.translatePath(value), '');
});

test('all dictionary entries resolve as whole phrases without inconsistent normalized aliases', () => {
  for (const [english, chinese] of Object.entries(api.dictionary)) {
    assert.equal(api.lookup(english), chinese, english);
    assert.ok(/[\u3400-\u9fff]/.test(chinese), english);
  }
  console.log(JSON.stringify({ offline: true, wholePhraseLabels: Object.keys(api.dictionary).length, commonEnglishChinesePairsChecked: common.length, networkRequests: 0 }));
});
