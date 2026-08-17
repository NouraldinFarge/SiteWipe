import yauzl from 'yauzl';

export function readZipEntries(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      zipFile.on('error', reject);
      zipFile.on('end', () => resolve(entries));
      zipFile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.push({
              path: entry.fileName,
              bytes: Buffer.concat(chunks),
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              modifiedAt: entry.getLastModDate().toISOString()
            });
            zipFile.readEntry();
          });
        });
      });
      zipFile.readEntry();
    });
  });
}
