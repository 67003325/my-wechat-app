Page({
  /**
   * 页面的初始数据
   */
  data: {
    // 封面信息
    projectName: '',  // 💡 初始为空，"xxx项目"以灰色占位符显示，输入后变黑色
    projectDateValue: '',       // 💡 初始留空，由 onLoad 动态注入标准格式 (如: 2026-10-12)
    projectDateDisplay: '',     // 💡 初始留空，由 onLoad 动态注入显示格式 (如: 2026年10月12日)

    // 是否有未提交的草稿（用于控制"清空草稿"按钮的显隐）
    hasDraft: false,
    // 草稿箱里的草稿数量（顶部提示用）
    draftCount: 0,

    // 查验子项预设选项（点击单元格弹出选择）
    subItemOptions: [
      '楼梯间，安全出口（净宽×净高）',
      '楼梯间，前室面积',
      '消防电梯，前室面积',
      '消防电梯，合用前室面积',
      '疏散走道尺寸（W×H）',
      '疏散门（W×H）',
      '建筑疏散距离',
      '走道疏散距离',
      '消火栓间距',
      '灭火器间距',
      '自然排烟/自然通风',
      '防爆泄压口面积',
      '防火间距',
      '消防车道（W×H，转弯半径）',
      '回车场地',
      '消防车登高场地（a×b，坡度）',
      '消防救援口的尺寸'
    ],

    // 查验子项列表
    checkItems: [
      {
        subItemName: '',       // 查验子项名称
        photoImage: '',        // 现场拍摄影像（显示用：本地临时路径或临时链接）
        photoData: '',         // 现场拍摄数据（显示用）
        location: '',          // 拍摄位置
        description: '',       // 拍摄说明
        photoImageFileID: '',  // 云端持久化 fileID（草稿/生成用）
        photoDataFileID: '',
        photoImageExpired: false,  // 草稿恢复时：图片无法恢复显示的标记
        photoDataExpired: false
      }
    ]
  },

  /**
   * 💡 核心升级：页面加载生命周期
   */
  onLoad: function() {
    // 💡 修复点：移除了无效的 wx.loadFontFace 调用
    // （原代码加载 https://gstatic.com——这不是字体文件，且域名不合法，
    //  会触发 CORS 拦截、合法域名校验出错、LoadFontFace 失败 3 个报错）
    // 小程序 UI 直接用系统字体；PDF/Word 的中文字体已内嵌在云函数中，不依赖此处

    // 1. 自动抓取当前手机系统的当天时间并做智能补零
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    // 3. 拼接并初始化回填数据
    const rawDate = `${year}-${month}-${day}`;
    const formattedDate = `${year}年${month}月${day}日`;

    this.setData({
      projectDateValue: rawDate,
      projectDateDisplay: formattedDate
    });

    // 💡 当前编辑的草稿身份（draftId）：null = 新项目，保存时新建一条
    //    改项目名不会换身份 → 保存时更新同一条，而不是新建
    this._currentDraftId = null;

    // 4. 启动后尝试恢复上次未提交的草稿（防闪退/强退导致数据丢失）
    this.tryRecoverDraft();

    // 5. 加载草稿箱数量（用于顶部"草稿箱有 N 个"提示）
    this.refreshDraftCount();
  },

  // 监听封面：项目名称输入
  onProjectNameInput: function(e) {
    this.setData({ projectName: e.detail.value });
    this.scheduleSaveDraft();
  },

  /**
   * 监听封面：日期选择器改变事件
   */
  onDateChange: function(e) {
    const rawDate = e.detail.value; // 格式如 "2026-10-12"
    const dateParts = rawDate.split('-');

    // 转换为符合你排版视觉的 "XXXX年XX月XX日"
    const formattedDate = `${dateParts[0]}年${dateParts[1]}月${dateParts[2]}日`;

    this.setData({
      projectDateValue: rawDate,
      projectDateDisplay: formattedDate
    });
    this.scheduleSaveDraft();
  },

  /**
   * 监听表格内部所有 input 的通用打字事件（解决循环列表动态绑定的核心方法）
   */
  onTableInput: function(e) {
    const index = e.currentTarget.dataset.index; // 知道是第几个表格
    const field = e.currentTarget.dataset.field; // 知道是哪一个输入框（如 subItemName）
    const value = e.detail.value;               // 获取输入的新值

    // 拿到旧数组
    let checkItems = this.data.checkItems;
    // 修改对应表格里对应字段的值
    checkItems[index][field] = value;

    // 动态回写到渲染层
    this.setData({
      checkItems: checkItems
    });
    this.scheduleSaveDraft();
  },

  /**
   * 核心交互：点击格子进行拍照或选择相册图片
   */
  onChooseImage: function(e) {
    const index = e.currentTarget.dataset.index; // 哪个表格
    const type = e.currentTarget.dataset.type;   // 现场拍摄影像(photoImage) 还是 现场拍摄数据(photoData)

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'], // 同时支持相册选择和相机拍照
      success: (res) => {
        // 获取图片的临时本地路径
        const tempFilePath = res.tempFiles[0].tempFilePath;

        let checkItems = this.data.checkItems;
        checkItems[index][type] = tempFilePath; // 塞入对应位置
        // 清除"图片已失效"标记（如果是从草稿恢复后重新上传）
        if (type + 'Expired' in checkItems[index]) {
          checkItems[index][type + 'Expired'] = false;
        }
        // 新选的图是本地临时路径，清掉旧的云端 fileID（下次保存时重新持久化）
        checkItems[index][type + 'FileID'] = '';

        this.setData({
          checkItems: checkItems
        });
        this.scheduleSaveDraft();

        wx.showToast({
          title: '上传成功',
          icon: 'success'
        });
      }
    });
  },

  /**
   * 核心功能：新增查验子项
   */
  onAddSubItem: function() {
    const newItem = {
      subItemName: '',
      photoImage: '',
      photoData: '',
      location: '',
      description: '',
      photoImageFileID: '',
      photoDataFileID: '',
      photoImageExpired: false,
      photoDataExpired: false
    };

    this.setData({
      checkItems: this.data.checkItems.concat(newItem)
    });
    this.scheduleSaveDraft();

    wx.showToast({
      title: '已新增查验表格',
      icon: 'none'
    });
  },

  /**
   * 删除指定索引的查验子项（带二次确认；至少保留 1 项）
   */
  onDeleteItem: function(e) {
    const idx = e.currentTarget.dataset.index;
    const items = this.data.checkItems;

    if (items.length <= 1) {
      return wx.showToast({ title: '至少保留一项', icon: 'none' });
    }

    const label = (items[idx] && items[idx].subItemName) || '未命名';
    wx.showModal({
      title: '删除确认',
      content: `确定删除「${label}」？删除后不可恢复（已生成的 Word/PDF 报告不受影响）。`,
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) return;
        const newItems = items.filter((_, i) => i !== idx);
        this.setData({ checkItems: newItems });
        this.scheduleSaveDraft();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /**
   * 新建项目：重置当前编辑区，开始填写新项目
   * 💡 不会删除云端已保存的草稿（仍在草稿箱里），只是清空编辑界面
   */
  onNewProject: function() {
    wx.showModal({
      title: '新建项目',
      content: '将清空当前编辑内容。\n\n已保存的草稿仍保留在「📂 草稿箱」里，可以随时恢复。\n\n确定开始新项目？',
      success: (r) => {
        if (!r.confirm) return;

        // 取消挂起的自动保存（防止 800ms 后用空数据覆盖云端）
        if (this._saveTimer) {
          clearTimeout(this._saveTimer);
          this._saveTimer = null;
        }

        // 断开与旧草稿的关联：下次保存会新建一条（新项目 = 新档案）
        this._currentDraftId = null;

        // 重置为今天 + 空白表单
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');

        this.setData({
          projectName: '',
          projectDateValue: `${yyyy}-${mm}-${dd}`,
          projectDateDisplay: `${yyyy}年${mm}月${dd}日`,
          checkItems: [
            {
              subItemName: '',
              photoImage: '',
              photoData: '',
              location: '',
              description: '',
              photoImageFileID: '',
              photoDataFileID: '',
              photoImageExpired: false,
              photoDataExpired: false
            }
          ],
          hasDraft: false
        });

        // 清本地缓存（避免下次启动又恢复成旧项目）
        try { wx.removeStorageSync(this.DRAFT_FILEID_KEY); } catch (e) {}
        try { wx.removeStorageSync(this.DRAFT_LOCAL_KEY); } catch (e) {}

        wx.showToast({ title: '已新建项目', icon: 'success' });
      }
    });
  },

  /**
   * 核心功能：保存资料（覆盖式，直接存到固定槽位，永远是最新版本）
   * - 不再弹命名框、不再产生新草稿记录
   * - 与自动保存共用同一个云端槽位（drafts/{openid}/autosave.json）
   */
  onSaveData: function() {
    this.saveDraft().then(() => {
      wx.showToast({ title: '已保存', icon: 'success' });
      // 💡 刷新底部"📂 草稿箱"后的红色徽章数字
      this.refreshDraftCount();
    }).catch((err) => {
      const msg = (err && (err.errMsg || err.message)) || JSON.stringify(err) || '未知错误';
      wx.showModal({
        title: '草稿保存失败',
        content: msg + '\n\n（请把这段文字发我排查）',
        showCancel: false
      });
    });
  },

  /**
   * 打开草稿箱：列出本人所有具名草稿 → 选择 → 恢复 / 删除
   */
  onOpenDraftBox: async function() {
    wx.showLoading({ title: '加载草稿箱...', mask: true });
    let items = [];
    try {
      const r = await wx.cloud.callFunction({
        name: 'draftManager',
        data: { action: 'list' }
      });
      wx.hideLoading();
      const result = r.result || {};
      if (!result.ok) throw new Error(result.error || '读取失败');
      // 💡 不再过滤 __autosave__，让自动保存也显示在草稿箱里（标注为"当前保存"）
      items = result.list || [];
    } catch (e) {
      wx.hideLoading();
      const msg = (e && (e.errMsg || e.message)) || '未知错误';
      return wx.showModal({ title: '草稿箱打开失败', content: msg, showCancel: false });
    }

    if (!items.length) {
      return wx.showToast({ title: '草稿箱为空', icon: 'none' });
    }

    // 1) 选草稿（showActionSheet 最多 6 项，取最近 5 条）
    // 💡 格式：项目名_YYYYMMDDHHmm（最紧凑：日期+时分无分隔）
    const recent = items.slice(0, 5);
    const recentLabels = recent.map((d) => {
      const date = new Date(d.savedAt);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mi = String(date.getMinutes()).padStart(2, '0');
      return `${d.name || '未命名项目'}_${yyyy}${mm}${dd}${hh}${mi}`;
    });

    // 只有多于 1 项时才显示"一键清空"（1 项的话直接选这条删就行）
    const showClearAll = items.length > 1;
    const labels = showClearAll
      ? [...recentLabels, `🗑 一键清空（共 ${items.length} 项）`]
      : recentLabels;
    const CLEAR_ALL_INDEX = showClearAll ? labels.length - 1 : -1;

    const pick = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: labels,
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(-1)
      });
    });
    if (pick < 0) return;

    // 选了"一键清空"
    if (showClearAll && pick === CLEAR_ALL_INDEX) {
      return this.onClearAllDraftsFromBox(items.length);
    }

    const chosen = recent[pick];

    // 2) 选操作：恢复 / 删除
    const act = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: ['恢复此草稿', '删除此草稿'],
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(-1)
      });
    });
    if (act === 0) {
      this.restoreSnapshot(chosen);
    } else if (act === 1) {
      wx.showModal({
        title: '删除草稿',
        content: `确定删除「${chosen.name}」？删除后不可恢复。`,
        confirmColor: '#ff4d4f',
        success: async (r) => {
          if (!r.confirm) return;
          wx.showLoading({ title: '正在删除...', mask: true });
          try {
            const dr = await wx.cloud.callFunction({
              name: 'draftManager',
              data: { action: 'delete', id: chosen._id, fileID: chosen.fileID }
            });
            wx.hideLoading();
            if (dr.result && dr.result.ok) {
              this.refreshDraftCount();
              wx.showToast({ title: '已删除', icon: 'success' });
            } else {
              throw new Error((dr.result && dr.result.error) || '删除失败');
            }
          } catch (e) {
            wx.hideLoading();
            const msg = (e && (e.errMsg || e.message)) || '未知错误';
            wx.showModal({ title: '删除失败', content: msg, showCancel: false });
          }
        }
      });
    }
  },

  /**
   * 草稿箱里触发一键清空：弹窗确认 → 调用 clearDraft(true) → 提示已清空
   */
  onClearAllDraftsFromBox: function(count) {
    wx.showModal({
      title: '一键清空草稿箱',
      content: `将删除草稿箱内全部 ${count} 个草稿（含云端文件），确定吗？\n删除后不可恢复。`,
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '正在清空...', mask: true });
        this.clearAllDrafts(true).then(() => {
          wx.hideLoading();
          wx.showToast({ title: '已清空草稿箱', icon: 'success' });
        }).catch(() => {
          wx.hideLoading();
          wx.showToast({ title: '清空失败', icon: 'none' });
        });
      }
    });
  },

  /**
   * 从草稿箱恢复一份具名草稿到当前编辑区
   */
  restoreSnapshot: async function(draftDoc) {
    wx.showLoading({ title: '正在恢复...', mask: true });
    try {
      const r = await wx.cloud.callFunction({
        name: 'draftManager',
        data: { action: 'get', fileID: draftDoc.fileID }
      });
      wx.hideLoading();
      const result = r.result || {};
      if (!result.ok) throw new Error(result.error || '读取失败');
      // 先用记录上的身份兜底（老记录内容里可能没有 draftId）
      if (draftDoc.draftId) this._currentDraftId = draftDoc.draftId;
      this.applyDraftData(result.data);
      wx.showToast({ title: '草稿已恢复', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      const msg = (e && (e.errMsg || e.message)) || '未知错误';
      wx.showModal({ title: '恢复失败', content: msg, showCancel: false });
    }
  },

  /**
   * 把草稿数据应用到页面（tryRecoverDraft / restoreSnapshot 共用）
   * 💡 图片处理：
   * - cloud:// fileID（新草稿）：批量换临时链接用于显示，fileID 保留在 xxxFileID 字段
   * - wxfile:// 本地路径（旧草稿）：标记已失效，提示重新上传
   */
  applyDraftData: async function(draft) {
    if (!draft || !Array.isArray(draft.checkItems) || !draft.checkItems.length) return false;

    // 💡 找回这份草稿的身份：之后改名再保存会更新同一条，而不是新建
    if (draft.draftId) this._currentDraftId = draft.draftId;

    // 1. 收集所有 cloud:// fileID，批量换取临时显示链接
    const fileIds = [];
    draft.checkItems.forEach((it) => {
      if (it.photoImage && it.photoImage.startsWith('cloud://')) fileIds.push(it.photoImage);
      if (it.photoData && it.photoData.startsWith('cloud://')) fileIds.push(it.photoData);
    });
    const urlMap = {};
    if (fileIds.length) {
      try {
        const res = await wx.cloud.getTempFileURL({ fileList: fileIds });
        (res.fileList || []).forEach((f) => {
          if (f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL;
        });
      } catch (e) {
        console.warn('图片临时链接获取失败', e);
      }
    }

    // 2. 逐项处理图片字段
    const checkItems = draft.checkItems.map((it) => {
      const item = { ...it };

      // 影像
      if (item.photoImage && item.photoImage.startsWith('cloud://')) {
        item.photoImageFileID = item.photoImage;          // fileID 留给生成/下次保存
        item.photoImage = urlMap[item.photoImage] || '';  // 临时链接用于显示
        item.photoImageExpired = !item.photoImage;        // 换不到链接 = 已失效
      } else {
        item.photoImageExpired = !!(item.photoImage && (item.photoImage.startsWith('wxfile://') || item.photoImage.startsWith('http://tmp')));
      }

      // 数据
      if (item.photoData && item.photoData.startsWith('cloud://')) {
        item.photoDataFileID = item.photoData;
        item.photoData = urlMap[item.photoData] || '';
        item.photoDataExpired = !item.photoData;
      } else {
        item.photoDataExpired = !!(item.photoData && (item.photoData.startsWith('wxfile://') || item.photoData.startsWith('http://tmp')));
      }

      return item;
    });

    this.setData({
      projectName: draft.projectName || '',
      projectDateValue: draft.projectDateValue || this.data.projectDateValue,
      projectDateDisplay: draft.projectDateDisplay || this.data.projectDateDisplay,
      checkItems,
      hasDraft: true
    });
    return true;
  },

  /**
   * 手动清空【当前项目】草稿（用户主动放弃未提交内容）
   * 💡 不会删草稿箱里其他项目，要删全部请用草稿箱里的"一键清空"
   */
  onClearDraft: function() {
    const pn = this.data.projectName || '未命名项目';
    wx.showModal({
      title: '清空当前草稿',
      content: `将删除项目「${pn}」的草稿。\n\n草稿箱里的其他项目不受影响。确定吗？`,
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (res.confirm) this.clearDraft(false);
      }
    });
  },

  /**
   * 通用工具：把 checkItems 里的本地临时图片上传到云存储，返回带 fileID 的新数组
   * 💡 已持久化过的图片（xxxFileID 有值）直接复用，不重复上传
   */
  uploadCheckItemsImages: async function(checkItems) {
    return Promise.all(checkItems.map(async (item, index) => {
      const uploadedItem = { ...item };

      // 现场拍摄影像
      if (item.photoImageFileID) {
        uploadedItem.photoImage = item.photoImageFileID;
      } else if (item.photoImage && (item.photoImage.startsWith('http://tmp') || item.photoImage.startsWith('wxfile://'))) {
        const resImg = await wx.cloud.uploadFile({
          cloudPath: `fire_check/${Date.now()}_img_${index}.jpg`,
          filePath: item.photoImage
        });
        uploadedItem.photoImage = resImg.fileID;
        uploadedItem.photoImageFileID = resImg.fileID;
      }

      // 现场拍摄数据
      if (item.photoDataFileID) {
        uploadedItem.photoData = item.photoDataFileID;
      } else if (item.photoData && (item.photoData.startsWith('http://tmp') || item.photoData.startsWith('wxfile://'))) {
        const resData = await wx.cloud.uploadFile({
          cloudPath: `fire_check/${Date.now()}_data_${index}.jpg`,
          filePath: item.photoData
        });
        uploadedItem.photoData = resData.fileID;
        uploadedItem.photoDataFileID = resData.fileID;
      }
      return uploadedItem;
    }));
  },

  /**
   * 查验子项选择器：从预设列表选一项填入对应表格
   */
  onSubItemPick: function(e) {
    const idx = e.currentTarget.dataset.index;
    const picked = this.data.subItemOptions[e.detail.value];
    this.setData({
      [`checkItems[${idx}].subItemName`]: picked
    });
    this.scheduleSaveDraft();
  },

  // ===================================================================
  // 草稿持久化与恢复（防闪退/强退导致数据丢失）
  // ===================================================================
  DRAFT_FILE_PATH: 'drafts/last_draft.json',  // 云存储路径（固定）
  DRAFT_FILEID_KEY: 'fire_check_draft_fileid', // 本地存储的草稿云端 fileID
  DRAFT_LOCAL_KEY: 'fire_check_draft_local',   // 本地存储的草稿内容（双保险）

  /**
   * 防抖：800ms 内多次输入只触发一次保存
   */
  scheduleSaveDraft: function() {
    if (this._saveDraftTimer) clearTimeout(this._saveDraftTimer);
    this._saveDraftTimer = setTimeout(() => this.saveDraft(), 800);
  },

  /**
   * 刷新草稿箱数量（顶部"草稿箱有 N 个"提示）
   * 失败静默，不影响主流程
   */
  refreshDraftCount: async function() {
    try {
      const r = await wx.cloud.callFunction({
        name: 'draftManager',
        data: { action: 'list' }
      });
      const list = (r.result && r.result.list) || [];
      // 💡 一项目一槽位，list 长度 = 项目数
      this.setData({ draftCount: list.length });
    } catch (e) { /* 云函数未部署或网络异常，静默 */ }
  },

  /**
   * 单张图片持久化：本地临时路径 → 上传云存储返回 fileID（带缓存去重，同一张图只传一次）
   */
  persistImage: async function(value, fileID, cloudPrefix) {
    // 已有云端 fileID（之前持久化过的）→ 直接复用
    if (fileID) return fileID;
    if (!value) return '';
    // 本地临时路径 → 上传
    if (value.startsWith('wxfile://') || value.startsWith('http://tmp') || value.startsWith('https://tmp')) {
      if (!this._imgUploadCache) this._imgUploadCache = {};
      if (this._imgUploadCache[value]) return this._imgUploadCache[value];
      try {
        const res = await wx.cloud.uploadFile({
          cloudPath: `${cloudPrefix}_${Date.now()}.jpg`,
          filePath: value
        });
        this._imgUploadCache[value] = res.fileID;
        return res.fileID;
      } catch (e) {
        console.warn('草稿图片上传失败', e);
        return value; // 上传失败保留原值（下次保存重试）
      }
    }
    // cloud:// fileID 或其他形式 → 原样保留
    return value;
  },

  /**
   * 组装草稿数据：把所有本地临时图片先持久化到云存储，
   * 草稿里统一存 cloud:// fileID，保证恢复后图片不失效
   */
  prepareDraftData: async function() {
    const prepared = await Promise.all(this.data.checkItems.map(async (item, index) => {
      const it = { ...item };
      it.photoImage = await this.persistImage(item.photoImage, item.photoImageFileID, `draft_images/img1_${index}`);
      it.photoData = await this.persistImage(item.photoData, item.photoDataFileID, `draft_images/img2_${index}`);
      return it;
    }));

    return {
      projectName: this.data.projectName,
      projectDateValue: this.data.projectDateValue,
      projectDateDisplay: this.data.projectDateDisplay,
      checkItems: prepared
    };
  },

  /**
   * 把当前表单内容序列化，存到云存储（主）+ 本地 Storage（备）
   * 💡 修复点：改走 draftManager 云函数（管理员权限写），彻底规避
   *    STORAGE_EXCEED_AUTHORITY（"仅创建者可写"ACL 导致的覆盖写被拒）
   * - 💡 按项目名归类（一项目一槽位，同名项目直接覆盖）
   * - 每个用户独立目录 drafts/{openid}/draft_{项目名}.json
   * - 图片先持久化到云端，草稿里存 fileID（恢复后图片不失效）
   * - 本地只缓存内容（万一云端没成功也有备份）
   */
  saveDraft: async function() {
    // 0) 💡 关键：进入就【同步】分配草稿身份，必须在任何 await 之前
    //    否则并发保存（自动保存 + 手动保存撞一起）会各自生成新 draftId，
    //    一次保存变出好几条档案。这里先定死身份，并发的几次就都写同一条。
    if (!this._currentDraftId) {
      this._currentDraftId = `d${Date.now()}${Math.floor(Math.random() * 1000)}`;
    }
    const draftId = this._currentDraftId;

    // 1) 图片持久化（本地临时路径 → 云端 fileID）
    const draft = await this.prepareDraftData();
    const json = JSON.stringify(draft);

    // 2) 本地双保险
    try { wx.setStorageSync(this.DRAFT_LOCAL_KEY, json); } catch (e) { /* 配额超限忽略 */ }

    // 3) 云端（云函数管理员权限写）
    //    💡 传 draftId：有则更新同一条（改项目名也只是改名），无则新建
    try {
      const res = await wx.cloud.callFunction({
        name: 'draftManager',
        data: {
          action: 'save',
          name: this.data.projectName || '',
          snapshot: false,
          draftId,
          data: draft
        }
      });
      const r = res.result || {};
      if (!r.ok) throw new Error(r.error || '云端保存失败');

      // 云端若返回了身份（理论上与本地一致），以云端为准
      if (r.draftId) this._currentDraftId = r.draftId;

      wx.setStorageSync(this.DRAFT_FILEID_KEY, r.fileID);
      if (!this.data.hasDraft) this.setData({ hasDraft: true });
      return r.fileID;
    } catch (e) {
      console.warn('草稿云端保存失败', e);
      throw e;
    }
  },

  /**
   * 只清本地缓存（不动云端）
   * 💡 用于：读取草稿失败 / 本地记录失效等情况，避免误删云端其他项目
   */
  clearLocalDraft: function() {
    try { wx.removeStorageSync(this.DRAFT_FILEID_KEY); } catch (e) {}
    try { wx.removeStorageSync(this.DRAFT_LOCAL_KEY); } catch (e) {}
  },

  /**
   * 清空【当前项目】的草稿（本地 + 云端该项目槽位）
   * 💡 一项目一槽位，所以只删当前项目那一条，其他项目不受影响
   * @param {boolean} silent 静默模式：成功生成后调用不弹 toast
   */
  clearDraft: async function(silent) {
    try { wx.removeStorageSync(this.DRAFT_FILEID_KEY); } catch (e) {}
    try { wx.removeStorageSync(this.DRAFT_LOCAL_KEY); } catch (e) {}
    // 云端：按草稿身份删当前这一条（不是按项目名，改名也不会误删别人）
    try {
      await wx.cloud.callFunction({
        name: 'draftManager',
        data: {
          action: 'deleteById',
          draftId: this._currentDraftId || '',
          name: this.data.projectName || ''   // 旧记录没有 draftId 时的兜底
        }
      });
    } catch (e) { /* 云函数未部署或已清理，忽略 */ }
    // 断开身份：继续编辑再保存会开一条新档案
    this._currentDraftId = null;
    this.setData({ hasDraft: false });
    this.refreshDraftCount();
    if (!silent) wx.showToast({ title: '草稿已清空', icon: 'success' });
  },

  /**
   * 清空【全部】草稿（本地 + 云端所有项目记录）
   * 💡 危险操作，只用于用户明确点了"一键清空"
   * @param {boolean} silent 静默模式
   */
  clearAllDrafts: async function(silent) {
    try { wx.removeStorageSync(this.DRAFT_FILEID_KEY); } catch (e) {}
    try { wx.removeStorageSync(this.DRAFT_LOCAL_KEY); } catch (e) {}
    // 云端：清空所有记录
    try {
      await wx.cloud.callFunction({
        name: 'draftManager',
        data: { action: 'clearAll' }
      });
    } catch (e) { /* 云函数未部署或已清理，忽略 */ }
    this.setData({ hasDraft: false, draftCount: 0 });
    if (!silent) wx.showToast({ title: '草稿已清空', icon: 'success' });
  },

  /**
   * 启动时尝试恢复草稿：
   * 1. 取本地存的 fileID；没有则退出
   * 2. 换取临时 URL 并拉取 JSON
   * 3. 弹窗让用户选择"恢复"或"放弃"
   * 4. 恢复时对失效图片打标记（不删除原值，生成时仍可走云端 fileID）
   */
  tryRecoverDraft: async function() {
    let fileID = wx.getStorageSync(this.DRAFT_FILEID_KEY);

    // 💡 兜底：本地没有记录（如换了手机），从云端草稿箱找
    // 现在每条记录 = 一个项目；多条时让用户选要恢复哪个
    if (!fileID) {
      try {
        const r = await wx.cloud.callFunction({
          name: 'draftManager',
          data: { action: 'list' }
        });
        const list = (r.result && r.result.list) || [];
        if (!list.length) return;

        let chosen = null;
        if (list.length === 1) {
          chosen = list[0];
        } else {
          // 多条：让用户选要恢复哪个项目
          const labels = list.slice(0, 6).map((d) => d.name || '未命名项目');
          const pick = await new Promise((resolve) => {
            wx.showActionSheet({
              itemList: labels,
              success: (rr) => resolve(rr.tapIndex),
              fail: () => resolve(-1)
            });
          });
          if (pick < 0) return;
          chosen = list[pick];
        }
        fileID = chosen.fileID;
        // 记住选中这份的身份（老记录内容里没 draftId 时靠它兜底）
        if (chosen.draftId) this._currentDraftId = chosen.draftId;
      } catch (e) { /* 云函数未部署或网络问题，忽略 */ }
    }
    if (!fileID) return;

    let draft = null;
    try {
      const tempRes = await wx.cloud.getTempFileURL({ fileList: [fileID] });
      const url = tempRes.fileList[0] && tempRes.fileList[0].tempFileURL;
      if (!url) throw new Error('草稿已失效');

      // 用 request 拉 JSON 内容
      const content = await new Promise((resolve, reject) => {
        wx.request({
          url,
          method: 'GET',
          success: (r) => resolve(r.data),
          fail: reject
        });
      });
      draft = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (e) {
      // 草稿已失效 —— 只清本地缓存，绝不动云端其他项目
      console.warn('草稿读取失败', e);
      this.clearLocalDraft();
      return;
    }

    if (!draft || !Array.isArray(draft.checkItems) || !draft.checkItems.length) {
      this.clearLocalDraft();
      return;
    }

    // 超过 30 天不弹
    if (Date.now() - (draft.savedAt || 0) > 30 * 24 * 60 * 60 * 1000) {
      this.clearLocalDraft();
      return;
    }

    const dateStr = new Date(draft.savedAt).toLocaleString('zh-CN', { hour12: false });
    const projectName = draft.projectName || '未命名项目';
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '发现未保存的草稿',
        content: `项目：${projectName}\n时间：${dateStr}\n查验子项：${draft.checkItems.length} 个\n是否恢复？`,
        confirmText: '恢复',
        cancelText: '放弃',
        success: (r) => resolve(r.confirm)
      });
    });

    if (!confirm) {
      // 不清空，用户可能想用草稿箱选别的项目
      return;
    }

    if (this.applyDraftData(draft)) {
      wx.showToast({ title: '草稿已恢复', icon: 'success' });
    }
  },

  /**
   * 通用工具：把项目名清洗为安全的本地文件名字段
   */
  safeFileName: function(name) {
    if (!name) return '未命名项目';
    return String(name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 50) || '未命名项目';
  },

  /**
   * 通用工具：把当前时间格式化为 YYYYMMDDhhmm（例：2026年10月10日12:15 → 202610101215）
   */
  formatTimestamp: function(d) {
    d = d || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  },

  /**
   * 通用工具：下载云文件到本地自定义路径（让"项目名"出现在文件实际名字上），
   *          然后调起微信原生预览（可转发/保存）
   * 💡 修复点：openDocument 成功/失败都要先 hideLoading，否则 mask 加载层会一直遮住页面点不动
   */
  downloadAndPreviewFile: async function(fileID, fileType, projectName) {
    // 将云文件ID换取临时下载链接
    const tempUrlRes = await wx.cloud.getTempFileURL({ fileList: [fileID] });
    const downloadUrl = tempUrlRes.fileList[0].tempFileURL;

    // 把项目名清洗后拼成最终本地文件名，例如：xxx项目_202610101215.docx
    const ext = fileType === 'pdf' ? 'pdf' : 'docx';
    const localFileName = `${this.safeFileName(projectName)}_${this.formatTimestamp()}.${ext}`;
    const localFilePath = `${wx.env.USER_DATA_PATH}/${localFileName}`;

    // 💡 先用 wx.downloadFile 拿到临时路径，再用 fs.copyFile 复制到带项目名的自定义路径
    //    （不用 fsm.downloadFile：该 API 在部分基础库/模拟器上不存在）
    const fsm = wx.getFileSystemManager();
    const downloadRes = await new Promise((resolve, reject) => {
      wx.downloadFile({
        url: downloadUrl,
        success: resolve,
        fail: reject
      });
    });

    await new Promise((resolve, reject) => {
      fsm.copyFile({
        srcPath: downloadRes.tempFilePath,
        destPath: localFilePath,
        success: resolve,
        fail: reject
      });
    });

    // 用项目名文件直接调起预览；用户保存/转发时显示的就是带项目名的真实文件名
    return new Promise((resolve, reject) => {
      wx.openDocument({
        filePath: localFilePath,
        fileType: fileType,
        showMenu: true, // 显示右上角分享菜单
        success: () => { wx.hideLoading(); resolve(); },
        fail: (err) => { wx.hideLoading(); reject(err); }
      });
    });
  },

  /**
   * 核心功能：生成 Word（云端 generateWord 云函数）
   */
  onExportWord: async function() {
    const { projectName, projectDateDisplay, checkItems } = this.data;

    // 1. 基础校验
    if (!projectName) {
      return wx.showToast({ title: '请输入项目名称', icon: 'none' });
    }

    wx.showLoading({ title: '正在上传图片...', mask: true });

    try {
      // 2. 上传本地临时图片换取云存储 fileID
      const finalCheckItems = await this.uploadCheckItemsImages(checkItems);

      // 3. 呼叫云函数生成 Word
      wx.showLoading({ title: '正在云端生成Word...', mask: true });
      const cloudRes = await wx.cloud.callFunction({
        name: 'generateWord',
        data: {
          projectName,
          projectDate: projectDateDisplay,
          checkItems: finalCheckItems
        }
      });

      // 4. 下载并打开预览（本地文件名以项目名命名）
      wx.showLoading({ title: '正在下载并打开...', mask: true });
      await this.downloadAndPreviewFile(cloudRes.result.fileID, 'docx', projectName);

      // 5. 💡 不再清空草稿：报告生成后草稿保留，方便回头修改再生成一版
      //    （要删请手动用「🗑 清空草稿」或草稿箱里的删除）
      wx.hideLoading();

    } catch (error) {
      wx.hideLoading();
      wx.showModal({
        title: '生成失败',
        content: error.message || '请确保云函数 generateWord 已上传并部署',
        showCancel: false
      });
    }
  },

  /**
   * 核心功能：生成 PDF 并在手机端打开预览（方案C - 微信云开发版）
   */
  onExportPDF: async function() {
    const { projectName, projectDateDisplay, checkItems } = this.data;

    // 1. 基础校验
    if (!projectName) {
      return wx.showToast({ title: '请输入项目名称', icon: 'none' });
    }

    wx.showLoading({ title: '正在上传图片...', mask: true });

    try {
      // 2. 上传本地临时图片换取云存储 fileID（与生成 Word 共用）
      const finalCheckItems = await this.uploadCheckItemsImages(checkItems);

      // 3. 呼叫微信云函数，开始在云端生成 PDF
      wx.showLoading({ title: '正在云端生成PDF...', mask: true });

      const cloudRes = await wx.cloud.callFunction({
        name: 'generatePDF',
        data: {
          projectName,
          projectDate: projectDateDisplay,
          checkItems: finalCheckItems
        }
      });

      // 4. 下载 PDF 并直接呼叫微信原生预览（本地文件名以项目名命名）
      wx.showLoading({ title: '正在下载并打开...', mask: true });
      await this.downloadAndPreviewFile(cloudRes.result.fileID, 'pdf', projectName);

      // 5. 💡 不再清空草稿：报告生成后草稿保留，方便回头修改再生成一版
      //    （要删请手动用「🗑 清空草稿」或草稿箱里的删除）
      wx.hideLoading();

    } catch (error) {
      wx.hideLoading();
      wx.showModal({
        title: '生成失败',
        content: error.message || '请确保已开通并初始化微信云开发环境',
        showCancel: false
      });
    }
  }
})
