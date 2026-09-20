'use strict';

// Thin promise wrapper around the official `ibmmq` client library.
// The library ships a native addon that needs the IBM MQ client
// redistributable libraries installed on this machine (see README).
// If it isn't installed/buildable, `loadError` is set and every real
// send fails fast with a clear message — Dry Run mode still works.

let mq = null;
let loadError = null;
try {
  mq = require('ibmmq');
} catch (err) {
  loadError = err;
}

function isAvailable() {
  return mq !== null;
}

function unavailableReason() {
  if (!loadError) return null;
  const shortMessage = String(loadError.message).split('\n')[0];
  return (
    'The "ibmmq" native module is not installed/built on this machine. ' +
    'Run "npm install" with the IBM MQ client redistributable libraries ' +
    'present (see README.md), or use Dry Run mode. ' +
    `Underlying error: ${shortMessage}`
  );
}

function connectAndPut({ host, port, channel, queueManager, queueName, userId, password, useTLS, cipherSpec }, buffer, mqmdOverrides = {}) {
  if (!mq) {
    return Promise.reject(new Error(unavailableReason()));
  }
  const MQC = mq.MQC;

  return new Promise((resolve, reject) => {
    const cno = new mq.MQCNO();
    cno.Options = MQC.MQCNO_CLIENT_BINDING;

    const cd = new mq.MQCD();
    cd.ConnectionName = `${host}(${port})`;
    cd.ChannelName = channel;

    if (useTLS && cipherSpec) {
      cd.SSLCipherSpec = cipherSpec;
      cno.SSLConfig = new mq.MQSCO();
    }

    cno.ClientConn = cd;

    if (userId) {
      const csp = new mq.MQCSP();
      csp.UserId = userId;
      if (password) csp.Password = password;
      cno.SecurityParms = csp;
    }

    mq.Connx(queueManager, cno, (connErr, hConn) => {
      if (connErr) {
        return reject(formatMqError('MQCONN failed', connErr));
      }

      const od = new mq.MQOD();
      od.ObjectName = queueName;
      od.ObjectType = MQC.MQOT_Q;
      const openOptions = MQC.MQOO_OUTPUT | MQC.MQOO_FAIL_IF_QUIESCING;

      mq.Open(hConn, od, openOptions, (openErr, hObj) => {
        if (openErr) {
          return mq.Disc(hConn, () => reject(formatMqError('MQOPEN failed', openErr)));
        }

        const mqmd = new mq.MQMD();
        if (mqmdOverrides.format) mqmd.Format = mqmdOverrides.format;
        if (mqmdOverrides.persistent) mqmd.Persistence = MQC.MQPER_PERSISTENT;
        if (mqmdOverrides.correlId) mqmd.CorrelId = Buffer.from(mqmdOverrides.correlId);

        const pmo = new mq.MQPMO();
        pmo.Options =
          MQC.MQPMO_NO_SYNCPOINT | MQC.MQPMO_NEW_MSG_ID |
          (mqmdOverrides.correlId ? 0 : MQC.MQPMO_NEW_CORREL_ID);

        mq.Put(hObj, mqmd, pmo, buffer, (putErr) => {
          const msgId = mqmd.MsgId ? Buffer.from(mqmd.MsgId).toString('hex') : null;

          mq.Close(hObj, 0, () => {
            mq.Disc(hConn, () => {
              if (putErr) {
                return reject(formatMqError('MQPUT failed', putErr));
              }
              resolve({ msgId });
            });
          });
        });
      });
    });
  });
}

function formatMqError(context, mqErr) {
  const reason = mqErr && mqErr.mqrc !== undefined ? mqErr.mqrc : undefined;
  const reasonName = reason !== undefined && mq ? mq.MQC.MQRC_STR(reason) : undefined;
  const message = mqErr && mqErr.message ? mqErr.message : String(mqErr);
  const parts = [context, message];
  if (reasonName) parts.push(`(reason: ${reasonName})`);
  const err = new Error(parts.join(' — '));
  err.mqReasonCode = reason;
  err.mqReasonName = reasonName;
  return err;
}

module.exports = { isAvailable, unavailableReason, connectAndPut };
