import { readFileSync } from 'node:fs'
const P = 'C:/Users/zxm/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const lines = readFileSync(P, 'utf8').split('\n')
const show = (a, b) => { for (let i = a; i <= b; i++) console.log(`${i}: ${lines[i - 1]}`) }
console.log('===== 1290-1340 (_store getter / check call site) =====')
show(1290, 1340)
console.log('\n===== 790-830 (provide) =====')
show(790, 830)
