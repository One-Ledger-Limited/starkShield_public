import { ApiClientError } from '../../lib/api-client';

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_PROOF: 'ZK proof 無效，請重新生成後再提交。',
  INVALID_SIGNATURE: '交易簽名無效，請重新連接錢包後重試。',
  INVALID_INTENT_METADATA: '交易參數不完整，請重新填寫交易資料。',
  ERR_EXPIRED_INTENT: '交易意圖已過期，請重新建立交易。',
  ERR_NONCE_REPLAY: '偵測到重複提交，請稍後重試。',
  DUPLICATE_INTENT: '此交易意圖已提交，請勿重複提交。',
  INVALID_ENCODING: '資料編碼錯誤，請重新生成並提交。',
  STORAGE_ERROR: '系統暫時繁忙，請稍後再試。',
  QUERY_ERROR: '查詢失敗，請稍後再試。',
  STATS_ERROR: '統計資料暫時不可用，請稍後再試。',
  SETTLEMENT_ERROR: '結算失敗，請稍後再試。',
  INVALID_STATE: '目前狀態不可執行此操作。',
  NOT_FOUND: '找不到對應資料。',
  UNAUTHORIZED: '未授權存取，請先登入後再操作。',
  AUTH_ERROR: '登入服務暫時不可用，請稍後再試。',
  UNKNOWN_ERROR: '發生未知錯誤，請稍後再試。',
};

export function toUserErrorMessage(error: unknown): string {
  const apiError = error as Partial<ApiClientError> | undefined;
  if (apiError?.code && ERROR_MESSAGES[apiError.code]) {
    return ERROR_MESSAGES[apiError.code];
  }
  if (apiError?.message && apiError.message.trim().length > 0) {
    return apiError.message;
  }
  return ERROR_MESSAGES.UNKNOWN_ERROR;
}
