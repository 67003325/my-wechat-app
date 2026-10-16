App({
  onLaunch: function () {
    // 💡 核心配置：开启并绑定你的微信云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上基础库以使用云能力');
    } else {
      wx.cloud.init({
        // 已经为你精准填入你的环境 ID
        env: 'cloud1-d4gzd7j848a458fc8', 
        traceUser: true, // 是否在将用户访问记录传回到云开发控制台
      });
    }
  }
})
