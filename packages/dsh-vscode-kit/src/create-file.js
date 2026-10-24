/** createFile 的两端共用参数门：新对象没有文档锚点，只有显式的“不存在”锚点。 */
import { BridgeError, ERR } from './protocol.js'

export const CREATE_FILE_MAX_BYTES = 1024 * 1024

export function createFileBytes(params, { stage } = {}) {
  const fail = (reason, message) => {
    throw new BridgeError(ERR.INVALID_PARAMS, message, {
      method: 'vscode.createFile', reason, ...(stage ? { stage } : {}),
    })
  }
  if (!params || !Object.hasOwn(params, 'expectedDisk') || params.expectedDisk === undefined) {
    fail('expected-disk-missing', 'createFile requires an explicit expectedDisk:null')
  }
  if (params.expectedDisk !== null) {
    fail('expected-disk-not-null', 'createFile only accepts expectedDisk:null')
  }
  if (typeof params.text !== 'string') fail('text-not-a-string', 'params.text must be a string (empty is allowed)')
  // Buffer.from 会把孤立代理项静默替换成 U+FFFD；逐码元验证，绝不接受有损编码。
  for (let i = 0; i < params.text.length; i++) {
    const c = params.text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = params.text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('not-encodable', 'text is not losslessly UTF-8 encodable')
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail('not-encodable', 'text is not losslessly UTF-8 encodable')
    }
  }
  if (Buffer.byteLength(params.text, 'utf8') > CREATE_FILE_MAX_BYTES) {
    fail('payload-too-large', 'createFile text exceeds 1 MiB of UTF-8')
  }
  return Buffer.from(params.text, 'utf8')
}
