'use strict'

const fs = require('./wrapped-fs')
const os = require('os')
const path = require('path')
const { promisify } = require('util')
const stream = require('stream')
const getFileIntegrity = require('./integrity')

const UINT32_MAX = 2 ** 32 - 1

const pipeline = promisify(stream.pipeline)

class Filesystem {
  constructor (src) {
    this.src = path.resolve(src)
    this.header = { files: Object.create(null) }
    this.offset = BigInt(0)
  }

  searchNodeFromDirectory (p) {
    let json = this.header
    const dirs = p.split(path.sep)
    for (const dir of dirs) {
      if (dir !== '.') {
        if (!json.files[dir]) {
          json.files[dir] = { files: Object.create(null) }
        }
        json = json.files[dir]
      }
    }
    return json
  }

  searchNodeFromPath (p) {
    p = path.relative(this.src, p)
    if (!p) { return this.header }
    const name = path.basename(p)
    const node = this.searchNodeFromDirectory(path.dirname(p))
    if (node.files == null) {
      node.files = Object.create(null)
    }
    if (node.files[name] == null) {
      node.files[name] = Object.create(null)
    }
    return node.files[name]
  }

  insertDirectory (p, shouldUnpack) {
    const node = this.searchNodeFromPath(p)
    if (shouldUnpack) {
      node.unpacked = shouldUnpack
    }
    node.files = node.files || Object.create(null)
    return node.files
  }

  async insertFile (p, shouldUnpack, file, options) {
    const dirNode = this.searchNodeFromPath(path.dirname(p))
    const node = this.searchNodeFromPath(p)
    if (shouldUnpack || dirNode.unpacked) {
      node.size = file.stat.size
      node.unpacked = true
      node.integrity = await getFileIntegrity(p)
      return Promise.resolve()
    }

    let size

    const transformed = options.transform && options.transform(p)
    if (transformed) {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'))
      const tmpfile = path.join(tmpdir, path.basename(p))
      const out = fs.createWriteStream(tmpfile)
      const readStream = fs.createReadStream(p)

      await pipeline(readStream, transformed, out)
      file.transformed = {
        path: tmpfile,
        stat: await fs.lstat(tmpfile)
      }
      size = file.transformed.stat.size
    } else {
      size = file.stat.size
    }

    // JavaScript cannot precisely present integers >= UINT32_MAX.
    if (size > UINT32_MAX) {
      throw new Error(`${p}: file size can not be larger than 4.2GB`)
    }

    node.size = size
    node.offset = this.offset.toString()
    node.integrity = await getFileIntegrity(p)
    if (process.platform !== 'win32' && (file.stat.mode & 0o100)) {
      node.executable = true
    }
    this.offset += BigInt(size)
  }

  insertLink (p) {
    const link = path.relative(fs.realpathSync(this.src), fs.realpathSync(p))
    if (link.substr(0, 2) === '..') {
      throw new Error(`${p}: file "${link}" links out of the package`)
    }
    const node = this.searchNodeFromPath(p)
    node.link = link
    return link
  }

  listFiles (options) {
    const files = []
    const fileInfos = [];
    const offsetMap = new Map();
    const fillFilesFromMetadata = function (basePath, metadata) {
      if (!metadata.files) {
        return
      }

      for (const [childPath, childMetadata] of Object.entries(metadata.files)) {
        const fullPath = path.join(basePath, childPath)
        const packState = childMetadata.unpacked ? 'unpack' : 'pack  '
        files.push((options && options.isPack) ? `${packState} : ${fullPath}` : fullPath)

        if(options){
          if(options.ignoreUnpack){
            if(childMetadata.unpacked){
              
              continue;
            }
          }

          if(options.ignoreFakeFile){
            let fileInfo = {fullPath, unpacked : childMetadata.unpacked || false, isdir: !!childMetadata.files ,offset: parseInt(childMetadata.offset || '0'), size : childMetadata.size, prevOK : false, nextOK: false};
            fileInfos.push(fileInfo)
            if(!offsetMap.has(fileInfo.offset)){
              offsetMap.set(fileInfo.offset,[])
            }

            offsetMap.get(fileInfo.offset).push(fileInfo);
          }
        }

        fillFilesFromMetadata(fullPath, childMetadata)
      }
    }

    fillFilesFromMetadata('/', this.header)

    if(options && options.ignoreFakeFile){
      //排序
      fileInfos.sort((a,b)=>a.offset - b.offset);

      //重组
      fileInfos.forEach((fi,idx)=>{
        if(fi.offset == 0){
          fi.prevOK = true;
        }

        if(idx + 1 == fileInfos.length){
          fi.nextOK = true;
        }
        else{
          let nextOK = offsetMap.has(fi.offset + fi.size);
          fi.nextOK = nextOK;

          // 调整后续的前序
          if(nextOK){
            offsetMap.get(fi.offset + fi.size).forEach(fin=>fin.prevOK = true);
          }          
        }       

      })

      let files = fileInfos.filter(fi=>fi.isdir || fi.unpacked || (fi.prevOK && fi.nextOK)).map(fi=>fi.fullPath);
      return files;
    }
    else{
      return files
    }
  }

  getNode (p) {
    const node = this.searchNodeFromDirectory(path.dirname(p))
    const name = path.basename(p)
    if (name) {
      return node.files[name]
    } else {
      return node
    }
  }

  getFile (p, followLinks) {
    followLinks = typeof followLinks === 'undefined' ? true : followLinks
    const info = this.getNode(p)

    if (!info) {
      throw new Error(`"${p}" was not found in this archive`)
    }

    // if followLinks is false we don't resolve symlinks
    if (info.link && followLinks) {
      return this.getFile(info.link)
    } else {
      return info
    }
  }
}

module.exports = Filesystem
