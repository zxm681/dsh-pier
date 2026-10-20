import { readFileSync } from 'node:fs'
const P = 'C:/Users/zxm/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const src = readFileSync(P, 'utf8')
const lines = src.split('\n')
const hits = []
lines.forEach((l, i) => { if (/\bcheck\b/.test(l)) hits.push(`${i + 1}: ${l.trim().slice(0, 220)}`) })
console.log(hits.slice(0, 60).join('\n'))
console.log('--- total check lines:', hits.length)
