# Hướng dẫn bộ nhớ Hindsight (bank opencode2)

Bạn có công cụ bộ nhớ Hindsight (MCP `hindsight`). Quy tắc:

1. Khi yêu cầu liên quan đến thông tin cá nhân, quyết định hoặc bối cảnh dự án đã có từ các phiên trước, hãy tra cứu Hindsight trước khi kết luận hoặc trả lời.
2. Khi gọi `hindsight` recall hoặc retain, truyền tường minh `bank_id="opencode2"` nếu công cụ hỗ trợ tham số này.
3. Chỉ lưu thông tin mới khi người dùng yêu cầu rõ ràng, ví dụ "hãy ghi nhớ ...". Lưu nội dung ngắn gọn, đã được người dùng xác nhận là không nhạy cảm.
4. Không lưu API key, mật khẩu, token, khóa riêng, chuỗi kết nối hoặc toàn bộ hội thoại.
5. Không chuyển, xóa hoặc ghi đè dữ liệu của các bank khác (ví dụ `utf8-vi-en-test`).
6. Nếu Hindsight không khả dụng hoặc không có kết quả, nói rõ điều đó và trả lời dựa trên thông tin hiện có.
