import { GoogleGenAI, Type } from '@google/genai';
import type {
  GeminiAdvisoryResponse,
  MarketRegime,
  MarketVenue,
  TechnicalIndicators,
} from '../engine/types';

const ADVISORY_MODEL = 'gemini-4-hydrogen';

export async function generateGeminiQuantAdvisory(params: {
  price: number;
  venue: MarketVenue;
  regime: MarketRegime;
  indicators: TechnicalIndicators;
  councilDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  councilScore: number;
}): Promise<GeminiAdvisoryResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  const now = Date.now();

  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
    return {
      configured: false,
      model: null,
      generatedAt: now,
      verdict: 'UNAVAILABLE',
      confidencePct: 0,
      rationale:
        'Chưa cấu hình GEMINI_API_KEY trên máy chủ backend. Hệ thống định lượng rule-based vẫn hoạt động bình thường.',
      riskWarnings: ['Advisory AI cần GEMINI_API_KEY hợp lệ trong biến môi trường server.'],
      disclaimer:
        'Phân tích tham khảo bổ trợ, không thay thế Risk Guardian và không tự động thực thi lệnh.',
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const prompt = [
      'Bạn là chuyên gia phân tích định lượng BTC/USDT. Hãy đánh giá khách quan dữ liệu thực tế sau bằng tiếng Việt, KHÔNG bịa số liệu:',
      `- Venue: ${params.venue}`,
      `- Giá hiện tại: $${params.price}`,
      `- Chế độ thị trường: ${params.regime}`,
      `- Hội đồng rule-based hiện tại: ${params.councilDirection} (${params.councilScore}/100)`,
      `- EMA21=${params.indicators.ema21.toFixed(1)}, EMA50=${params.indicators.ema50.toFixed(1)}, EMA200=${params.indicators.ema200.toFixed(1)}`,
      `- RSI14=${params.indicators.rsi14.toFixed(1)}, ADX14=${params.indicators.adx14.toFixed(1)}, ATR14=$${params.indicators.atr14.toFixed(1)} (${params.indicators.atrPct}%)`,
      `- Spread=${params.indicators.spreadBps} bps, Orderbook Imbalance=${params.indicators.orderbookImbalance}, VolRatio=${params.indicators.volumeRatio}x`,
      `- HTF (${params.indicators.htfSource}): H1=${params.indicators.h1Bias}, H4=${params.indicators.h4Bias}, D1=${params.indicators.d1Bias}`,
      `- Volume Profile POC=$${params.indicators.volumeProfile.poc}, VAH=$${params.indicators.volumeProfile.vah}, VAL=$${params.indicators.volumeProfile.val}`,
      `- Funding=${params.indicators.fundingRate !== null ? (params.indicators.fundingRate * 100).toFixed(4) + '%' : 'N/A (Spot)'}`,
      'Trả về JSON phân tích ngắn gọn rủi ro và khuyến nghị WAIT/LONG/SHORT mang tính tham khảo.',
    ].join('\n');

    const response = await ai.models.generateContent({
      model: ADVISORY_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            verdict: {
              type: Type.STRING,
              description: 'One of LONG, SHORT, WAIT',
            },
            confidencePct: {
              type: Type.NUMBER,
              description: 'Confidence from 0 to 100',
            },
            rationale: {
              type: Type.STRING,
              description: 'Concise Vietnamese technical rationale based strictly on provided inputs',
            },
            riskWarnings: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['verdict', 'confidencePct', 'rationale', 'riskWarnings'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}') as {
      verdict?: string;
      confidencePct?: number;
      rationale?: string;
      riskWarnings?: string[];
    };

    const verdict =
      parsed.verdict === 'LONG' || parsed.verdict === 'SHORT' || parsed.verdict === 'WAIT'
        ? parsed.verdict
        : 'WAIT';

    return {
      configured: true,
      model: ADVISORY_MODEL,
      generatedAt: Date.now(),
      verdict,
      confidencePct: Math.max(0, Math.min(100, Math.round(Number(parsed.confidencePct) || 50))),
      rationale: parsed.rationale || 'Không có diễn giải chi tiết.',
      riskWarnings: Array.isArray(parsed.riskWarnings) ? parsed.riskWarnings.slice(0, 4) : [],
      disclaimer:
        'Kết quả từ Gemini AI chỉ mang tính tham khảo bổ trợ — KHÔNG phải tín hiệu giao dịch chắc chắn và KHÔNG được phép bỏ qua Risk Guardian.',
    };
  } catch (err) {
    return {
      configured: true,
      model: ADVISORY_MODEL,
      generatedAt: Date.now(),
      verdict: 'UNAVAILABLE',
      confidencePct: 0,
      rationale: `Không thể truy vấn Gemini AI lúc này (${err instanceof Error ? err.message : 'Network error'}).`,
      riskWarnings: ['Hệ thống tự động tiếp tục sử dụng hội đồng định lượng rule-based.'],
      disclaimer: 'Advisory AI đang gián đoạn.',
    };
  }
}
