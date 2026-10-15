const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DRAFT_COLLECTION = 'drafts';

/**
 * 确保草稿元数据集合存在（首次调用自动创建，重复创建忽略报错）
 */
async function ensureCollection() {
  try {
    await db.createCollection(DRAFT_COLLECTION);
  } catch (e) { /* 集合已存在时抛错，忽略 */ }
}

/**
 * 草稿箱云函数（单入口，按 action 分发）
 *
 * - save   { name, data, snapshot }  保存草稿
 *     snapshot=false → 自动保存：覆盖写 drafts/{openid}/autosave.json（固定槽位）
 *     snapshot=true  → 具名快照：新建文件 + 登记到草稿箱集合（手机端可见、可删）
 * - list   {}                        草稿箱列表（仅本人的）
 * - get    { fileID }                读取草稿 JSON 内容
 * - delete { id, fileID }            删除草稿箱里的具名草稿（校验归属）
 * - deleteAutosave {}               删除自动保存槽位（文件 + 记录）
 *
 * 💡 为什么走云函数：云函数用管理员身份读写云存储，
 *    不受"仅创建者可写"ACL 限制，彻底规避 STORAGE_EXCEED_AUTHORITY
 */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  try {
    switch (action) {
      // ================= 保存 =================
      case 'save': {
        const { name, data, snapshot } = event;
        const stamp = Date.now();

        await ensureCollection();

        if (snapshot) {
          // 具名快照（遗留分支，保留兼容）
          const cleanName = String(name || '草稿').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 50);
          const fileName = `${stamp}_${cleanName}.json`;
          const cloudPath = `drafts/${OPENID}/${fileName}`;
          const up = await cloud.uploadFile({
            cloudPath,
            fileContent: Buffer.from(JSON.stringify({ ...data, name: cleanName, savedAt: stamp }), 'utf-8')
          });
          await db.collection(DRAFT_COLLECTION).add({
            data: { _openid: OPENID, name: cleanName, fileID: up.fileID, savedAt: stamp }
          });
          return { ok: true, fileID: up.fileID, savedAt: stamp };
        }

        // 💡 自动保存：按项目名归类（一项目一槽位，同名覆盖）
        const projectName = (data && data.projectName && String(data.projectName).trim()) || '未命名项目';
        const normalized = projectName
          .replace(/[\s\\/:*?"<>|]+/g, '_')   // 空白与非法字符 → 下划线
          .replace(/^_+|_+$/g, '')             // 去首尾下划线
          .slice(0, 50) || '未命名项目';
        const docId = `draft_${OPENID}_${normalized}`;
        const fileName = `draft_${normalized}.json`;   // 同名项目固定文件名 → 上传自动覆盖
        const cloudPath = `drafts/${OPENID}/${fileName}`;

        const up = await cloud.uploadFile({
          cloudPath,
          fileContent: Buffer.from(JSON.stringify({ ...data, name: projectName, savedAt: stamp }), 'utf-8')
        });

        await db.collection(DRAFT_COLLECTION).doc(docId).set({
          data: { _openid: OPENID, name: projectName, fileID: up.fileID, savedAt: stamp }
        });

        return { ok: true, fileID: up.fileID, savedAt: stamp, projectName };
      }

      // ================= 草稿箱列表（仅本人） =================
      case 'list': {
        await ensureCollection();
        const res = await db.collection(DRAFT_COLLECTION)
          .where({ _openid: OPENID })
          .orderBy('savedAt', 'desc')
          .limit(20)
          .get();
        return { ok: true, list: res.data };
      }

      // ================= 读取草稿内容 =================
      case 'get': {
        const res = await cloud.downloadFile({ fileID: event.fileID });
        return { ok: true, data: JSON.parse(res.fileContent.toString('utf-8')) };
      }

      // ================= 删除具名草稿 =================
      case 'delete': {
        const { id, fileID } = event;
        let doc = null;
        try {
          doc = await db.collection(DRAFT_COLLECTION).doc(id).get();
        } catch (e) { /* 记录不存在 */ }

        // 仅当记录带有 _openid 且不匹配时才拒绝（旧记录可能没有该字段）
        if (doc && doc.data && doc.data._openid && doc.data._openid !== OPENID) {
          return { ok: false, error: '无权限删除他人草稿' };
        }

        if (fileID) {
          await cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
        }
        if (doc && doc.data) {
          await db.collection(DRAFT_COLLECTION).doc(id).remove();
        }
        return { ok: true };
      }

      // ================= 删除自动保存槽位 =================
      case 'deleteAutosave': {
        let doc = null;
        try {
          doc = await db.collection(DRAFT_COLLECTION).doc(`auto_${OPENID}`).get();
        } catch (e) { /* 记录不存在 */ }

        if (doc && doc.data && doc.data.fileID) {
          await cloud.deleteFile({ fileList: [doc.data.fileID] }).catch(() => {});
        }
        if (doc && doc.data) {
          await db.collection(DRAFT_COLLECTION).doc(`auto_${OPENID}`).remove();
        }
        return { ok: true };
      }

      // ================= 一键清空所有草稿（具名快照 + 自动保存） =================
      case 'clearAll': {
        await ensureCollection();
        const res = await db.collection(DRAFT_COLLECTION)
          .where({ _openid: OPENID })
          .limit(100)
          .get();
        const records = res.data || [];
        const fileIds = records.map((d) => d.fileID).filter(Boolean);
        // 批量删文件（云存储一次最多 50 个，分批）
        for (let i = 0; i < fileIds.length; i += 50) {
          const chunk = fileIds.slice(i, i + 50);
          await cloud.deleteFile({ fileList: chunk }).catch(() => {});
        }
        // 逐条删记录
        for (const rec of records) {
          await db.collection(DRAFT_COLLECTION).doc(rec._id).remove().catch(() => {});
        }
        return { ok: true, count: records.length };
      }

      default:
        return { ok: false, error: '未知 action: ' + action };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
