/**
 * utils/ble-printer.js
 * BLE（低功耗蓝牙）连接工具，支持 ESP32 设备搜索、连接、数据读写
 *
 * 目标设备名称：ESP32S3_BLE
 * 服务 UUID：4FAFC201-1FB5-459E-8FCC-C5C9C331914B
 * 特征值 UUID：BEB5483E-36E1-4688-B7F5-EA07361B26A8（WRITE + NOTIFY）
 *
 * ===== 协议流程（sendImageData） =====
 *   START (0x01)  →  DATA ×8 (0x02)  →  END (0x03)  →  等待 READY  →  PRINT (0x04)
 */

// 默认目标设备 UUID
const DEFAULT_CONFIG = {
  SERVICE_UUID: '4FAFC201-1FB5-459E-8FCC-C5C9C331914B',
  CHAR_UUID: 'BEB5483E-36E1-4688-B7F5-EA07361B26A8',
};

// 目标设备名称（自动连接用）
const TARGET_DEVICE_NAME = 'AI自动印章';

function BLEPrinter() {
  this._deviceId = '';
  this._deviceName = '';
  this._serviceId = DEFAULT_CONFIG.SERVICE_UUID;
  this._charId = DEFAULT_CONFIG.CHAR_UUID;
  this._connected = false;
  this._adapterOpen = false;
  this._discovering = false;

  // 缓存的特征值对象
  this._writeChar = null;
  this._notifyChar = null;

  // 等待 NOTIFY 回复的 resolver（由 _waitForNotify 设置）
  this._notifyResolver = null;

  // ========== 外部回调 ==========
  this.onFoundDevice = null;       // function(device)
  this.onConnected = null;         // function(name)
  this.onDisconnected = null;      // function()
  this.onSendProgress = null;      // function(current, total, msg)
  this.onSendComplete = null;      // function()
  this.onError = null;             // function(msg)
  this.onLog = null;               // function(msg)
}

/**
 * 设置自定义 UUID（如果不使用默认值）
 */
BLEPrinter.prototype.setUUID = function (serviceUuid, txUuid, rxUuid) {
  // 兼容旧接口：txUuid 写特征值，rxUuid 通知特征值
  this._serviceId = serviceUuid || DEFAULT_CONFIG.SERVICE_UUID;
  this._charId = txUuid || DEFAULT_CONFIG.CHAR_UUID;
  if (this._connected) {
    this._log('📋 UUID 已更新，重新连接后生效');
  }
};

/**
 * 获取当前平台
 */
BLEPrinter.prototype._getPlatform = function () {
  try {
    var sysInfo = wx.getSystemInfoSync();
    return (sysInfo.platform || '').toLowerCase();
  } catch (e) {
    return '';
  }
};

/**
 * 初始化蓝牙适配器（带重试和权限检查）
 * 严格遵循：openBluetoothAdapter
 *
 * 注意：
 * - 每次调用前会先关闭旧适配器，避免重复打开出错
 * - Android 需要位置权限（定位权限）才能扫描 BLE
 * - iOS 需要系统蓝牙授权
 */
BLEPrinter.prototype.openAdapter = function () {
  var that = this;
  return new Promise(function (resolve, reject) {
    // 第一步：无脑关闭一次旧适配器，清除 iOS 上的状态残留
    that._log('🧹 清理蓝牙适配器残留状态...');
    wx.closeBluetoothAdapter({
      success: function () {
        that._adapterOpen = false;
        setTimeout(function () {
          that._doOpenAdapter(0, 3, resolve, reject);
        }, 500);
      },
      fail: function () {
        that._adapterOpen = false;
        setTimeout(function () {
          that._doOpenAdapter(0, 3, resolve, reject);
        }, 500);
      },
    });
  });
};

/**
 * 递归执行打开适配器，最多重试 3 次
 */
BLEPrinter.prototype._doOpenAdapter = function (attempt, maxAttempts, resolve, reject) {
  var that = this;

  // 如果之前已打开，先关闭避免冲突
  if (that._adapterOpen) {
    that._log('🔄 检测到已打开的适配器，先关闭再重试...');
    wx.closeBluetoothAdapter({
      success: function () {
        that._adapterOpen = false;
        setTimeout(function () {
          that._tryOpen(attempt, maxAttempts, resolve, reject);
        }, 300);
      },
      fail: function () {
        that._adapterOpen = false;
        setTimeout(function () {
          that._tryOpen(attempt, maxAttempts, resolve, reject);
        }, 300);
      },
    });
  } else {
    that._tryOpen(attempt, maxAttempts, resolve, reject);
  }
};


/**
 * 尝试打开蓝牙适配器
 */
BLEPrinter.prototype._tryOpen = function (attempt, maxAttempts, resolve, reject) {
  var that = this;
  that._log('🔧 打开蓝牙适配器 (尝试 ' + (attempt + 1) + '/' + maxAttempts + ')');

  wx.openBluetoothAdapter({
    mode: 'central',
    success: function (res) {
      that._adapterOpen = true;
      that._log('✅ 蓝牙适配器初始化成功');
      resolve(res);
    },
    fail: function (err) {
      that._adapterOpen = false;
      that._log('❌ 蓝牙适配器初始化失败: ' + err.errMsg);

      var nextAttempt = attempt + 1;
      if (nextAttempt < maxAttempts) {
        that._log('⏳ 等待 1 秒后重试...');
        setTimeout(function () {
          that._doOpenAdapter(nextAttempt, maxAttempts, resolve, reject);
        }, 1000);
      } else {
        // 全部重试失败，给出友好的错误提示
        that._handleOpenError(err);
        reject(err);
      }
    },
  });
};

/**
 * 处理蓝牙打开失败（重试用尽后）
 * 根据平台（iOS / Android）显示不同的错误指引
 */
BLEPrinter.prototype._handleOpenError = function (err) {
  var that = this;

  // 判断当前平台
  var platform = that._getPlatform();
  var isIOS = platform.indexOf('ios') >= 0 || platform.indexOf('iphone') >= 0 || platform.indexOf('ipad') >= 0;

  // 构建平台专属的提示文案
  var getContentByPlatform = function (title, iosContent, androidContent) {
    if (isIOS) {
      return iosContent;
    } else {
      return androidContent;
    }
  };

  // 延迟执行，让前面的日志先刷新
  setTimeout(function () {
    wx.getBluetoothAdapterState({
      success: function (stateRes) {
        if (stateRes.available) {
          that._log('⚠️ 蓝牙已可用，但 openAdapter 失败，可能是权限问题');
          wx.showModal({
            title: '蓝牙权限不足',
            content: getContentByPlatform(
              '',
              '请检查微信的蓝牙权限设置：\n\n' +
              '📱 iOS: 打开「设置」→「微信」→ 开启「蓝牙」开关\n\n' +
              '如果仍无法连接，请尝试重启微信。',
              '请检查：\n\n' +
              '📱 Android: \n1. 确保已开启「位置信息」(GPS)\n' +
              '2. 设置 → 应用 → 微信 → 权限 → 开启「位置信息」\n\n' +
              '蓝牙扫描需要位置权限。'
            ),
            showCancel: false,
          });
        } else {
          wx.showModal({
            title: '蓝牙未开启',
            content: getContentByPlatform(
              '',
              '请在「控制中心」打开蓝牙开关，或前往\n' +
              '📱 iOS: 「设置」→「蓝牙」→ 开启蓝牙',
              '请确保手机蓝牙已打开，并授予微信位置信息权限。\n\n' +
              '📱 Android: 下拉状态栏开启蓝牙 + 位置信息'
            ),
            showCancel: false,
          });
        }
      },
      fail: function () {
        // getBluetoothAdapterState 也失败了，直接使用错误信息判断
        var errMsg = (err.errMsg || '') + (err.errCode !== undefined ? ' (错误码: ' + err.errCode + ')' : '');
        var isDenied = (errMsg.indexOf('deny') >= 0 || errMsg.indexOf('reject') >= 0);

        if (isDenied) {
          wx.showModal({
            title: '权限不足',
            content: getContentByPlatform(
              '',
              '微信未被授权使用蓝牙。\n\n' +
              '📱 iOS: 打开「设置」→「微信」→ 开启「蓝牙」\n\n' +
              '如已开启，请尝试「关闭微信后台」后重新打开。',
              '微信未被授予位置/蓝牙权限。\n\n' +
              '📱 Android: 设置 → 应用 → 微信 → 权限 →\n' +
              '开启「位置信息」和「附近设备」权限'
            ),
            showCancel: false,
          });
        } else {
          wx.showModal({
            title: '蓝牙初始化失败',
            content: getContentByPlatform(
              '',
              'iOS 蓝牙异常，请尝试：\n\n' +
              '1️⃣ 打开「控制中心」检查蓝牙已开启\n' +
              '2️⃣ 「设置」→「微信」→ 蓝牙已开启\n' +
              '3️⃣ 重启微信后再试\n' +
              '4️⃣ 重启手机（如持续失败）',
              '蓝牙初始化失败，请尝试：\n\n' +
              '1️⃣ 手机蓝牙已打开\n' +
              '2️⃣ 位置信息已开启（GPS）\n' +
              '3️⃣ 微信有位置信息权限\n' +
              '4️⃣ 重启蓝牙或重启手机'
            ),
            showCancel: false,
          });
        }
      },
    });
  }, 100);
};



/**
 * 关闭蓝牙适配器
 */
BLEPrinter.prototype.closeAdapter = function () {
  if (this._discovering) {
    this.stopScan();
  }
  if (this._connected) {
    this.disconnect();
  }
  if (this._adapterOpen) {
    var that = this;
    wx.closeBluetoothAdapter({
      success: function () {
        that._adapterOpen = false;
        that._log('🔌 蓝牙适配器已关闭');
      },
      fail: function () {
        that._adapterOpen = false;
      },
    });
  }
};

/**
 * 开始扫描蓝牙设备
 * 严格遵循：openBluetoothAdapter -> startBluetoothDevicesDiscovery -> onBluetoothDeviceFound
 *
 * 注意：allowDuplicatesKey 设为 true，这样 iOS 设备名会持续更新，
 * 某些设备首次发现时可能没有名称，后续广播包到达时会补全名称。
 */
BLEPrinter.prototype.startScan = function () {
  var that = this;
  return new Promise(function (resolve, reject) {
    // Step 1: 打开蓝牙适配器
    that.openAdapter().then(function () {
      // Step 2: 开始扫描（允许重复发现，以便 iOS 获取设备名称）
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        interval: 0,
        success: function (res) {
          that._discovering = true;
          that._log('🔍 正在扫描 BLE 设备...');
          // Step 3: 监听设备发现
          wx.onBluetoothDeviceFound(function (res) {
            that._onDeviceFound(res);
          });
          resolve(res);
        },
        fail: function (err) {
          that._log('❌ 扫描失败: ' + err.errMsg);
          wx.showToast({ title: '蓝牙扫描失败', icon: 'none' });
          // 判断是否定位权限问题
          if (err.errMsg && err.errMsg.indexOf('deny') >= 0) {
            wx.showModal({
              title: '定位权限不足',
              content: '蓝牙扫描需要定位权限，请在系统设置中允许微信获取位置信息',
              showCancel: false,
            });
          }
          reject(err);
        },
      });
    }).catch(function (err) {
      reject(err);
    });
  });
};


/**
 * 内部：处理发现的设备
 * 展示所有设备（包括无名称的），方便用户手动选择
 */
BLEPrinter.prototype._onDeviceFound = function (res) {
  var that = this;
  var devices = res.devices || [];
  devices.forEach(function (device) {
    // 从多个字段尝试获取名称
    var name = device.name || device.localName || '';
    var displayName = name || ('未知设备 (' + (device.deviceId || '').slice(0, 8) + '...)');

    // 构建设备对象
    var dev = {
      deviceId: device.deviceId,
      name: name,
      displayName: displayName,
      RSSI: device.RSSI || 0,
      advertisServiceUUIDs: device.advertisServiceUUIDs || [],
    };

    // 通知页面发现设备（用于显示列表）
    if (typeof that.onFoundDevice === 'function') {
      that.onFoundDevice(dev);
    }

    // === 自动连接目标设备（支持模糊匹配） ===
    var isTarget = false;
    if (name) {
      // 精确匹配
      if (name === TARGET_DEVICE_NAME) isTarget = true;
      // 大小写不敏感匹配
      if (name.toUpperCase() === TARGET_DEVICE_NAME.toUpperCase()) isTarget = true;
      // 包含目标名称（某些 ESP32 固件会在名称后加后缀）
      if (name.indexOf(TARGET_DEVICE_NAME) >= 0) isTarget = true;
    }

    if (isTarget) {
      that._log('🎯 发现目标设备: ' + name + ' (RSSI: ' + dev.RSSI + ')');
      that._log('⏹️ 自动停止扫描，准备连接...');

      // 停止扫描
      that.stopScan();

      // 延迟一小段时间后自动连接，确保设备稳定
      setTimeout(function () {
        that.connect(device.deviceId, name);
      }, 500);
    }
  });
};


/**
 * 停止扫描
 */
BLEPrinter.prototype.stopScan = function () {
  if (!this._discovering) return;
  var that = this;
  wx.stopBluetoothDevicesDiscovery({
    success: function () {
      that._discovering = false;
      that._log('⏹️ 扫描已停止');
    },
    fail: function () {
      that._discovering = false;
    },
  });
};

/**
 * 连接蓝牙设备
 * 严格遵循：createBLEConnection -> getBLEDeviceServices -> getBLEDeviceCharacteristics
 */
BLEPrinter.prototype.connect = function (deviceId, deviceName) {
  var that = this;
  that._deviceId = deviceId;
  that._deviceName = deviceName || '未知设备';

  return new Promise(function (resolve, reject) {
    wx.showLoading({ title: '连接中...', mask: true });

    // Step 1: 创建 BLE 连接
    wx.createBLEConnection({
      deviceId: deviceId,
      timeout: 15000,
      success: function () {
        that._log('🔗 连接成功，正在获取服务...');
        that._connected = true;

        // Step 2: 获取服务
        that._getServicesAndChars(deviceId).then(function () {
          wx.hideLoading();

          // 监听连接状态变化（断开重连等）
          wx.onBLEConnectionStateChange(function (res) {
            if (!res.connected) {
              that._handleDisconnect();
            }
          });

          that._log('✅ 已连接到: ' + deviceName);
          if (typeof that.onConnected === 'function') {
            that.onConnected(deviceName);
          }
          resolve();
        }).catch(function (err) {
          wx.hideLoading();
          that._log('❌ 获取服务/特征值失败');
          wx.showModal({
            title: '连接失败',
            content: '无法获取设备的服务和特征值，请确认设备 UUID 是否正确',
            showCancel: false,
          });
          that.disconnect();
          reject(err);
        });
      },
      fail: function (err) {
        wx.hideLoading();
        that._connected = false;
        that._log('❌ 连接失败: ' + err.errMsg);
        wx.showModal({
          title: '连接失败',
          content: '无法连接到 ' + deviceName + '，请确保设备在范围内并已开启',
          showCancel: false,
        });
        if (typeof that.onError === 'function') {
          that.onError('连接失败: ' + deviceName);
        }
        reject(err);
      },
    });
  });
};

/**
 * 内部：获取服务和特征值
 */
BLEPrinter.prototype._getServicesAndChars = function (deviceId) {
  var that = this;
  return new Promise(function (resolve, reject) {
    // 获取所有服务
    wx.getBLEDeviceServices({
      deviceId: deviceId,
      success: function (res) {
        var services = res.services || [];
        that._log('📋 发现 ' + services.length + ' 个服务');

        // 查找目标服务（支持大小写模糊匹配）
        var targetService = null;
        var targetUuid = that._serviceId.toLowerCase();

        for (var i = 0; i < services.length; i++) {
          var svcUuid = services[i].uuid.toLowerCase();
          if (svcUuid.indexOf(targetUuid) >= 0 || targetUuid.indexOf(svcUuid) >= 0) {
            targetService = services[i];
            break;
          }
        }

        if (!targetService) {
          that._log('⚠️ 未找到目标服务 UUID: ' + that._serviceId);
          // 如果没找到，使用第一个可用服务（兼容模式）
          if (services.length > 0) {
            targetService = services[0];
            that._log('⚠️ 使用第一个可用服务: ' + targetService.uuid);
          } else {
            reject(new Error('未找到可用服务'));
            return;
          }
        }

        that._log('🔧 使用服务: ' + targetService.uuid);

        // 获取该服务下的特征值
        wx.getBLEDeviceCharacteristics({
          deviceId: deviceId,
          serviceId: targetService.uuid,
          success: function (charRes) {
            var chars = charRes.characteristics || [];
            that._log('📋 发现 ' + chars.length + ' 个特征值');

            var targetCharUuid = that._charId.toLowerCase();
            var foundWrite = null;
            var foundNotify = null;

            for (var j = 0; j < chars.length; j++) {
              var cUuid = chars[j].uuid.toLowerCase();
              var props = chars[j].properties || {};

              // 精确匹配目标 UUID
              if (cUuid.indexOf(targetCharUuid) >= 0 || targetCharUuid.indexOf(cUuid) >= 0) {
                if (props.write || props.writeNoResponse) {
                  foundWrite = chars[j];
                }
                if (props.notify || props.indicate) {
                  foundNotify = chars[j];
                }
              }

              // 后备：找到第一个 write/noitfy 但不一定匹配 UUID
              if (!foundWrite && (props.write || props.writeNoResponse)) {
                foundWrite = chars[j];
              }
              if (!foundNotify && (props.notify || props.indicate)) {
                foundNotify = chars[j];
              }
            }

            // 保存特征值
            that._serviceId = targetService.uuid;
            that._writeChar = foundWrite;
            that._notifyChar = foundNotify;

            if (foundWrite) {
              that._charId = foundWrite.uuid;
              that._log('✏️ 写特征值: ' + foundWrite.uuid);
            } else {
              that._log('⚠️ 未找到可写的特征值');
            }

            if (foundNotify) {
              that._log('🔔 通知特征值: ' + foundNotify.uuid);
              // 启用 NOTIFY
              that._enableNotify(deviceId, targetService.uuid, foundNotify.uuid);
            } else {
              that._log('⚠️ 未找到通知特征值');
            }

            resolve();
          },
          fail: function (err) {
            that._log('❌ 获取特征值失败: ' + err.errMsg);
            reject(err);
          },
        });
      },
      fail: function (err) {
        that._log('❌ 获取服务失败: ' + err.errMsg);
        reject(err);
      },
    });
  });
};

/**
 * 启用 NOTIFY
 * 监听 ESP32 通过 Notify 回传的数据（如 "READY"、"ERROR_*" 等）
 */
BLEPrinter.prototype._enableNotify = function (deviceId, serviceId, charId) {
  var that = this;
  // 先关闭之前的 notify
  wx.notifyBLECharacteristicValueChange({
    deviceId: deviceId,
    serviceId: serviceId,
    characteristicId: charId,
    state: true,
    success: function () {
      that._log('✅ 已启用通知');
      // 监听通知数据
      wx.onBLECharacteristicValueChange(function (res) {
        // 将接收到的 ArrayBuffer 转成字符串
        var arr = new Uint8Array(res.value);
        var str = '';
        for (var i = 0; i < arr.length; i++) {
          str += String.fromCharCode(arr[i]);
        }
        that._log('📩 收到设备数据: ' + str);

        // 如果有等待 NOTIFY 回复的 resolver，调用它
        if (typeof that._notifyResolver === 'function') {
          that._notifyResolver(str);
        }
      });
    },
    fail: function (err) {
      that._log('⚠️ 启用通知失败: ' + err.errMsg);
    },
  });
};

/**
 * 处理断开连接
 */
BLEPrinter.prototype._handleDisconnect = function () {
  this._connected = false;
  this._deviceId = '';
  this._writeChar = null;
  this._notifyChar = null;
  this._notifyResolver = null;
  this._log('⚠️ 蓝牙连接已断开');

  wx.showModal({
    title: '连接已断开',
    content: '蓝牙设备 ' + this._deviceName + ' 已断开连接',
    showCancel: false,
    success: function () {
      // 可在此处添加自动重连逻辑
    },
  });

  if (typeof this.onDisconnected === 'function') {
    this.onDisconnected();
  }
};

/**
 * 断开连接
 */
BLEPrinter.prototype.disconnect = function () {
  if (!this._deviceId) return;
  var that = this;
  wx.closeBLEConnection({
    deviceId: this._deviceId,
    success: function () {
      that._connected = false;
      that._log('🔌 已断开连接');
    },
    fail: function () {
      that._connected = false;
    },
  });
};

/**
 * 发送数据（字符串 -> ArrayBuffer）
 * @param {string} strData 要发送的字符串
 */
BLEPrinter.prototype.writeString = function (strData) {
  var that = this;

  return new Promise(function (resolve, reject) {
    if (!that._connected || !that._writeChar) {
      wx.showToast({ title: '请先连接蓝牙设备', icon: 'none' });
      reject(new Error('未连接'));
      return;
    }

    // 字符串 转 ArrayBuffer
    var buffer = that._stringToArrayBuffer(strData);

    that._log('📤 发送数据: ' + strData + ' (长度: ' + buffer.byteLength + ' 字节)');

    wx.writeBLECharacteristicValue({
      deviceId: that._deviceId,
      serviceId: that._serviceId,
      characteristicId: that._charId,
      value: buffer,
      success: function (res) {
        that._log('✅ 数据发送成功');
        resolve(res);
      },
      fail: function (err) {
        that._log('❌ 数据发送失败: ' + err.errMsg);
        wx.showToast({ title: '发送失败: ' + err.errMsg, icon: 'none' });
        reject(err);
      },
    });
  });
};

// =========================================================================
//  新增 API：发送二进制 ArrayBuffer
// =========================================================================

/**
 * 发送原始二进制数据（ArrayBuffer）
 * @param {ArrayBuffer} buffer 要发送的二进制数据
 * @returns {Promise}
 */
BLEPrinter.prototype.writeBuffer = function (buffer) {
  var that = this;

  return new Promise(function (resolve, reject) {
    if (!that._connected || !that._writeChar) {
      if (typeof that.onError === 'function') {
        that.onError('请先连接蓝牙设备');
      }
      reject(new Error('未连接'));
      return;
    }

    // 打印原始十六进制到控制台，方便逐包验证
    var view = new Uint8Array(buffer);
    var hexParts = [];
    for (var i = 0; i < view.length; i++) {
      hexParts.push(view[i].toString(16).toUpperCase().padStart(2, '0'));
    }
    console.log('[BLE] 📦 发送原始包 [' + view.length + ' 字节]: 0x' + hexParts.join(' 0x'));

    wx.writeBLECharacteristicValue({

      deviceId: that._deviceId,
      serviceId: that._serviceId,
      characteristicId: that._charId,
      value: buffer,
      success: function (res) {
        resolve(res);
      },
      fail: function (err) {
        var errCode = err.errCode !== undefined ? err.errCode : 'unknown';
        that._log('❌ 发送失败 (错误码: ' + errCode + '): ' + err.errMsg);
        reject(err);
      },
    });
  });
};

// =========================================================================
//  新增 API：协议化发送 128 字节图像数据
// =========================================================================

/**
 * 核心 API：按照 ESP32 协议发送图像数据
 *
 * 流程：
 *   1. START 包  →  2. DATA ×8  →  3. END 包
 *   4. 等待 ESP32 回复 "READY"  →  5. PRINT 命令
 *
 * @param {Uint8Array} uint8ArrayData 128 字节的图像数据（32×32 点阵位图）
 * @returns {Promise}
 */
BLEPrinter.prototype.sendImageData = function (uint8ArrayData) {
  var that = this;
  // 总步骤：1 START + 8 DATA + 1 END + 1 PRINT = 11
  var TOTAL_STEPS = 11;
  var currentStep = 0;

  return new Promise(function (resolve, reject) {
    // ---- 前置检查 ----
    if (!that._connected || !that._writeChar) {
      reject(new Error('未连接蓝牙设备'));
      return;
    }

    if (!uint8ArrayData || !uint8ArrayData.length) {
      reject(new Error('图像数据为空'));
      return;
    }

    if (uint8ArrayData.length !== 128) {
      reject(new Error('图像数据长度必须为 128 字节，当前为 ' + uint8ArrayData.length + ' 字节'));
      return;
    }

    that._updatePrintProgress(0, TOTAL_STEPS, '🚀 开始发送图像数据...');
    that._log('📐 图像数据: ' + uint8ArrayData.length + ' 字节');

    // ================================================================
    //  第 1 步：发送 START 包
    // ================================================================
    // 固定格式：[0x01, 0x01, 0x20(32), 0x20(32), 0x14(20), 0x00, 0x80(128)]
    var startPacket = new Uint8Array([0x01, 0x01, 0x20, 0x20, 0x14, 0x00, 0x80]);
    currentStep++;
    that._updatePrintProgress(currentStep, TOTAL_STEPS, '发送 START 包...');

    that.writeBuffer(startPacket.buffer).then(function () {
      that._log('✅ START 包发送成功');

      // ================================================================
      //  第 2 步：逐包发送 8 个 DATA 包（使用递归确保串行发送）
      // ================================================================
      that._sendDataPackets(uint8ArrayData, 0, TOTAL_STEPS, currentStep, resolve, reject);

    }).catch(function (err) {
      var msg = 'START 包发送失败: ' + (err.errMsg || err.message || '');
      that._log('❌ ' + msg);
      reject(new Error(msg));
    });
  });
};

/**
 * 递归发送 DATA 包（保证顺序发送，前一包成功后才发下一包）
 *
 * @param {Uint8Array} data    128 字节图像数据
 * @param {number}     seq     当前包序号（0-7）
 * @param {number}     totalSteps   总步骤数（固定 11）
 * @param {number}     currentStep  已完成步骤数
 * @param {function}   resolve 完成回调
 * @param {function}   reject  失败回调
 */
BLEPrinter.prototype._sendDataPackets = function (data, seq, totalSteps, currentStep, resolve, reject) {
  var that = this;
  var PACKET_COUNT = 8;
  var DATA_PER_PACKET = 16;

  // 所有 DATA 包发送完毕，进入 END 阶段
  if (seq >= PACKET_COUNT) {
    that._log('📦 所有 DATA 包发送完毕，准备发送 END 包');
    that._sendEndPacket(data, totalSteps, currentStep, resolve, reject);
    return;
  }

  // 构建 DATA 包
  // 格式：[0x02, seq, 16, ...16字节数据...]
  var offset = seq * DATA_PER_PACKET;
  var packet = new Uint8Array(3 + DATA_PER_PACKET);
  packet[0] = 0x02;                     // 包类型
  packet[1] = seq;                      // 包序号 (0-7)
  packet[2] = DATA_PER_PACKET;          // 数据长度 (16)
  for (var i = 0; i < DATA_PER_PACKET; i++) {
    packet[3 + i] = data[offset + i];   // 16 字节图像数据
  }

  var step = currentStep + 1;
  that._updatePrintProgress(step, totalSteps, '发送 DATA #' + (seq + 1) + '/' + PACKET_COUNT);

  that.writeBuffer(packet.buffer).then(function () {
    that._log('✅ DATA 包 #' + seq + ' 发送成功');
    // 递归发送下一包
    that._sendDataPackets(data, seq + 1, totalSteps, step, resolve, reject);
  }).catch(function (err) {
    var msg = 'DATA 包 #' + seq + ' 发送失败 (错误码: ' + (err.errCode || 'unknown') + '): ' + (err.errMsg || '');
    that._log('❌ ' + msg);
    reject(new Error(msg));
  });
};

/**
 * 计算累加和，发送 END 包，然后等待 READY 回复
 *
 * @param {Uint8Array} data        128 字节图像数据
 * @param {number}     totalSteps      总步骤数
 * @param {number}     currentStep     已完成步骤数
 * @param {function}   resolve     完成回调
 * @param {function}   reject      失败回调
 */
BLEPrinter.prototype._sendEndPacket = function (data, totalSteps, currentStep, resolve, reject) {
  var that = this;

  // ---- 计算累加和（求和后取低 16 位） ----
  var sum = 0;
  for (var i = 0; i < data.length; i++) {
    sum += data[i];
  }
  var checksum = sum & 0xFFFF;
  var checksumH = (checksum >> 8) & 0xFF;
  var checksumL = checksum & 0xFF;

  // 格式化输出（兼容低版本 JS 环境，不用 padStart）
  var checksumHex = checksum.toString(16).toUpperCase();
  while (checksumHex.length < 4) { checksumHex = '0' + checksumHex; }
  that._log('🔢 Checksum = 0x' + checksumHex + ' (H=0x' + checksumH.toString(16).toUpperCase() + ', L=0x' + checksumL.toString(16).toUpperCase() + ')');

  // ---- 构建并发送 END 包 ----
  // 格式：[0x03, 0x08, ChecksumH, ChecksumL]
  var endPacket = new Uint8Array([0x03, 0x08, checksumH, checksumL]);
  var step = currentStep + 1;
  that._updatePrintProgress(step, totalSteps, '发送 END 包...');

  that.writeBuffer(endPacket.buffer).then(function () {
    that._log('✅ END 包发送成功，等待 ESP32 回复 READY...');

    // ================================================================
    //  第 4 步：等待 ESP32 回复 "READY"
    // ================================================================
    that._waitForReady(10000).then(function () {
      that._log('✅ 收到 READY 回复');

      // ================================================================
      //  第 5 步：发送 PRINT 命令
      // ================================================================
      that._sendPrintCommand(totalSteps, step, resolve, reject);
    }).catch(function (err) {
      reject(err);
    });
  }).catch(function (err) {
    var msg = 'END 包发送失败 (错误码: ' + (err.errCode || 'unknown') + '): ' + (err.errMsg || '');
    that._log('❌ ' + msg);
    reject(new Error(msg));
  });
};

/**
 * 等待 ESP32 回复 "READY" 字符串
 * 也会处理 ERROR_* 等错误回复
 *
 * @param {number} timeoutMs 超时时间（毫秒）
 * @returns {Promise}
 */
BLEPrinter.prototype._waitForReady = function (timeoutMs) {
  var that = this;
  timeoutMs = timeoutMs || 10000;

  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      that._notifyResolver = null;
      that._log('⏰ 等待 READY 回复超时 (' + timeoutMs + 'ms)');
      reject(new Error('等待 READY 回复超时'));
    }, timeoutMs);

    // 设置 resolver，当收到通知数据时被调用
    that._notifyResolver = function (str) {
      if (str === 'READY') {
        clearTimeout(timer);
        that._notifyResolver = null;
        resolve();
      } else if (str.indexOf('ERROR') === 0) {
        // 设备返回错误回复
        clearTimeout(timer);
        that._notifyResolver = null;
        that._log('❌ 设备返回错误: ' + str);
        reject(new Error('设备返回错误: ' + str));
      }
      // 其他字符串忽略，继续等待 READY
    };
  });
};

/**
 * 发送 PRINT 命令
 * 格式：[0x04, 0x10]
 *
 * @param {number}   totalSteps  总步骤数
 * @param {number}   currentStep 已完成步骤数
 * @param {function} resolve     完成回调
 * @param {function} reject      失败回调
 */
BLEPrinter.prototype._sendPrintCommand = function (totalSteps, currentStep, resolve, reject) {
  var that = this;

  var printPacket = new Uint8Array([0x04, 0x10]);
  var step = currentStep + 1;
  that._updatePrintProgress(step, totalSteps, '发送 PRINT 命令...');

  that.writeBuffer(printPacket.buffer).then(function () {
    that._log('✅ PRINT 命令发送成功！');
    that._updatePrintProgress(totalSteps, totalSteps, '✅ 全部发送完成！');

    if (typeof that.onSendComplete === 'function') {
      that.onSendComplete();
    }
    resolve();
  }).catch(function (err) {
    var msg = 'PRINT 命令发送失败 (错误码: ' + (err.errCode || 'unknown') + '): ' + (err.errMsg || '');
    that._log('❌ ' + msg);
    reject(new Error(msg));
  });
};

// =========================================================================
//  辅助工具
// =========================================================================

/**
 * 将 32×32 的二维点阵数组转换为 128 字节的 Uint8Array
 * （位图格式：每 8 个点压缩为 1 字节，高位在前）
 *
 * @param {Array<Array<number>>} gridData 32×32 二维数组，值 0(黑)/1(白)
 * @returns {Uint8Array} 128 字节的图像数据
 */
BLEPrinter.prototype.gridToImageData = function (gridData) {
  if (!gridData || gridData.length === 0) {
    return new Uint8Array(128);
  }

  var rows = gridData.length;
  var cols = gridData[0] ? gridData[0].length : 0;

  var result = new Uint8Array(128);

  for (var row = 0; row < rows && row < 32; row++) {
    for (var col = 0; col < cols && col < 32; col++) {
      var pixel = gridData[row][col] || 0;
      // 计算字节索引和位偏移
      var bitIndex = row * 32 + col;
      var byteIndex = Math.floor(bitIndex / 8);
      var bitOffset = 7 - (bitIndex % 8); // 高位在前
      // 只设置值为 1 的像素（白色点）
      if (pixel === 1) {
        result[byteIndex] |= (1 << bitOffset);
      }
    }
  }

  return result;
};

/**
 * 发送打印数据（兼容现有打印机功能）
 * @param {Array<Array<number>>} gridData 32×32 点阵数据
 */
BLEPrinter.prototype.sendPrintData = function (gridData) {
  var that = this;
  if (!gridData || gridData.length === 0) {
    wx.showToast({ title: '没有打印数据', icon: 'none' });
    return;
  }

  // 将网格转为打印命令
  var rows = gridData.length;
  var cols = gridData[0] ? gridData[0].length : 0;
  var totalPackets = rows + 2; // 2 个额外命令
  var sentCount = 0;

  // 通知开始
  if (typeof this.onSendProgress === 'function') {
    this.onSendProgress(0, totalPackets, '准备发送...');
  }

  // 发送初始化命令
  this.writeString('INIT').then(function () {
    sentCount++;
    that._updatePrintProgress(sentCount, totalPackets, '初始化...');

    // 逐行发送点阵数据
    var sendRow = function (rowIndex) {
      if (rowIndex >= rows) {
        // 所有行发送完毕，发送结束命令
        that.writeString('END').then(function () {
          sentCount++;
          that._updatePrintProgress(sentCount, totalPackets, '发送完成');
          if (typeof that.onSendComplete === 'function') {
            that.onSendComplete();
          }
        }).catch(function () {
          if (typeof that.onError === 'function') {
            that.onError('发送结束命令失败');
          }
        });
        return;
      }

      // 将一行数据转为字符串
      var rowData = gridData[rowIndex] || [];
      var rowStr = '';
      for (var c = 0; c < rowData.length; c++) {
        rowStr += rowData[c] === 1 ? '1' : '0';
      }

      that.writeString('ROW:' + rowStr).then(function () {
        sentCount++;
        that._updatePrintProgress(sentCount, totalPackets, '第 ' + (rowIndex + 1) + '/' + rows + ' 行');
        sendRow(rowIndex + 1);
      }).catch(function () {
        if (typeof that.onError === 'function') {
          that.onError('第 ' + (rowIndex + 1) + ' 行发送失败');
        }
      });
    };

    sendRow(0);
  }).catch(function () {
    if (typeof that.onError === 'function') {
      that.onError('初始化命令发送失败');
    }
  });
};

/**
 * 更新打印进度
 */
BLEPrinter.prototype._updatePrintProgress = function (current, total, msg) {
  if (typeof this.onSendProgress === 'function') {
    this.onSendProgress(current, total, msg);
  }
};

/**
 * 工具：字符串转 ArrayBuffer
 * 注意：微信小程序不支持 TextEncoder，使用 Uint8Array 手动转换
 */
BLEPrinter.prototype._stringToArrayBuffer = function (str) {
  var buf = new ArrayBuffer(str.length);
  var bufView = new Uint8Array(buf);
  for (var i = 0; i < str.length; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
};


/**
 * 脱机调试：不依赖蓝牙连接，直接将协议包打印到控制台
 * 适用于在开发者工具中验证包格式是否正确
 *
 * @param {Uint8Array} uint8ArrayData 128 字节的图像数据
 */
BLEPrinter.prototype.debugPrintPackets = function (uint8ArrayData) {
  var that = this;
  if (!uint8ArrayData || uint8ArrayData.length !== 128) {
    console.log('[BLE Debug] ❌ 图像数据长度必须为 128 字节，当前为 ' + (uint8ArrayData ? uint8ArrayData.length : '0') + ' 字节');
    return;
  }

  console.log('============================================');
  console.log('  🔍 BLE 协议调试（脱机模式）');
  console.log('============================================');
  console.log('  📐 图像数据: ' + uint8ArrayData.length + ' 字节');
  console.log('');

  // ---- 1. START 包 ----
  var startPacket = new Uint8Array([0x01, 0x01, 0x20, 0x20, 0x14, 0x00, 0x80]);
  console.log('[START] 0x01 0x01 0x20 0x20 0x14 0x00 0x80  (' + startPacket.length + ' 字节)');

  // ---- 2. DATA 包 ×8 ----
  var PACKET_COUNT = 8;
  var DATA_PER_PACKET = 16;
  for (var seq = 0; seq < PACKET_COUNT; seq++) {
    var offset = seq * DATA_PER_PACKET;
    var packet = new Uint8Array(3 + DATA_PER_PACKET);
    packet[0] = 0x02;
    packet[1] = seq;
    packet[2] = DATA_PER_PACKET;
    for (var j = 0; j < DATA_PER_PACKET; j++) {
      packet[3 + j] = uint8ArrayData[offset + j];
    }
    // 转 hex 字符串
    var hexParts = [];
    for (var k = 0; k < packet.length; k++) {
      hexParts.push(packet[k].toString(16).toUpperCase().padStart(2, '0'));
    }
    console.log('[DATA #' + seq + '] 0x' + hexParts.join(' 0x') + '  (' + packet.length + ' 字节)');
  }

  // ---- 3. Checksum & END 包 ----
  var sum = 0;
  for (var i = 0; i < uint8ArrayData.length; i++) {
    sum += uint8ArrayData[i];
  }
  var checksum = sum & 0xFFFF;
  var checksumH = (checksum >> 8) & 0xFF;
  var checksumL = checksum & 0xFF;
  var checksumHex = checksum.toString(16).toUpperCase();
  while (checksumHex.length < 4) { checksumHex = '0' + checksumHex; }
  console.log('[CHKSUM] sum=' + sum + ', checksum=0x' + checksumHex + ' (H=0x' + checksumH.toString(16).toUpperCase() + ', L=0x' + checksumL.toString(16).toUpperCase() + ')');

  var endPacket = new Uint8Array([0x03, 0x08, checksumH, checksumL]);
  var endHex = [];
  for (var m = 0; m < endPacket.length; m++) {
    endHex.push(endPacket[m].toString(16).toUpperCase().padStart(2, '0'));
  }
  console.log('[END]   0x' + endHex.join(' 0x') + '  (' + endPacket.length + ' 字节)');

  // ---- 4. PRINT 包 ----
  console.log('[PRINT] 0x04 0x10  (2 字节)');

  console.log('');
  console.log('============================================');
  console.log('  ✅ 调试结束 — 共 1 START + 8 DATA + 1 END + 1 PRINT = 11 包');
  console.log('============================================');
};

/**
 * 内部日志
 */
BLEPrinter.prototype._log = function (msg) {

  console.log('[BLE]', msg);
  if (typeof this.onLog === 'function') {
    this.onLog(msg);
  }
};

/**
 * 获取当前连接状态
 */
BLEPrinter.prototype.isConnected = function () {
  return this._connected;
};

/**
 * 获取当前设备名称
 */
BLEPrinter.prototype.getDeviceName = function () {
  return this._deviceName;
};

module.exports = BLEPrinter;
