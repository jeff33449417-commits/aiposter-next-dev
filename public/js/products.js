// AI Poster product catalog (extracted from index.html).
// Loaded as a classic script before app.js; AI_POSTER_PRODUCTS becomes a global.
const AI_POSTER_PRODUCTS = [
    { id: 'p1', no: 1, series: 'Series 1', name: 'Ai Poster S(店鋪名牌)', size: '168.75 × 300', width: 168.75, height: 300, ratio: '9:16', orientation: '直式', environment: '室內' },
    { id: 'p2', no: 2, series: 'Series 1', name: 'Ai Poster M(促銷/櫥窗海報)', size: '337.5 × 600', width: 337.5, height: 600, ratio: '9:16', orientation: '直式', environment: '室內' },
    { id: 'p3', no: 3, series: 'Series 1', name: 'Ai Poster M Golden', size: '270 × 480', width: 270, height: 480, ratio: '9:16', orientation: '直式', environment: '室內' },
    { id: 'p4', no: 4, series: 'Series 1', name: 'Ai Poster L(迎賓/形象牆)', size: '675 × 1200', width: 675, height: 1200, ratio: '9:16', orientation: '直式', environment: '室內' },
    { id: 'p5', no: 5, series: 'Series 2', name: '促銷條形屏', size: '1920 × 160', width: 1920, height: 160, ratio: '12:1', orientation: '橫式', environment: '室內' },
    { id: 'p6', no: 6, series: 'Series 2', name: '迎賓促銷長條形屏(環繞一圈)', size: '15360 (1920×8) × 160', width: 15360, height: 160, ratio: '96:1', orientation: '橫式', environment: '室內' },
    { id: 'p7', no: 7, series: 'Series 2', name: '迎賓促銷直立屏', size: '320 × 1920', width: 320, height: 1920, ratio: '1:6', orientation: '直式', environment: '室內' },
    { id: 'p8', no: 8, series: 'Series 2', name: '戶外促銷條形屏', size: '1920 × 160', width: 1920, height: 160, ratio: '12:1', orientation: '橫式', environment: '戶外' },
    { id: 'p9', no: 9, series: 'Series 2', name: '戶外促銷直立柱形屏', size: '320 × 1920', width: 320, height: 1920, ratio: '1:6', orientation: '直式', environment: '戶外' },
    { id: 'p10', no: 10, series: 'Series 3', name: '室內騎樓雙面屏', size: '320 × 320 ×2面', width: 320, height: 320, ratio: '1:1', orientation: '正方形', environment: '室內' },
    { id: 'p11', no: 11, series: 'Series 3', name: '戶外路邊雙面屏', size: '320 × 320 ×2面', width: 320, height: 320, ratio: '1:1', orientation: '正方形', environment: '戶外' },
    { id: 'p12', no: 12, series: 'Series 3', name: '戶外促銷雙面條形屏', size: '960 × 320 ×2面', width: 960, height: 320, ratio: '3:1', orientation: '橫式', environment: '戶外' },
    { id: 'p13', no: 13, series: 'Series 4', name: '四面促銷立方屏', size: '320 × 320 ×4面', width: 320, height: 320, ratio: '1:1', orientation: '正方形', environment: '室內' },
    { id: 'p14', no: 14, series: 'Series 5', name: '雙環形促銷屏', size: '內環2560(外環3200)', width: 3200, height: 163, ratio: '圓環(非矩形)', orientation: '環形', environment: '室內', nonRectangular: true },
    { id: 'p15', no: 15, series: 'Series 6', name: '戶外迎賓促銷直立屏', size: '640 × 1120', width: 640, height: 1120, ratio: '4:7', orientation: '直式', environment: '戶外' },
    { id: 'p16', no: 16, series: 'Series 7', name: '戶外A字促銷屏', size: '480 × 640', width: 480, height: 640, ratio: '3:4', orientation: '直式', environment: '戶外' },
    { id: 'p17', no: 17, series: 'Series 8', name: '透明屏 3.91', size: '1000 × 1500', width: 1000, height: 1500, ratio: '2:3', orientation: '直式', environment: '室內' },
    { id: 'p18', no: 18, series: 'Series 8', name: '透明屏 6.25', size: '2000 × 1150', width: 2000, height: 1150, ratio: '40:23', orientation: '橫式', environment: '室內' },
    { id: 'p19', no: 19, series: 'Series 8', name: '透明屏 10.416', size: '2000 × 2500', width: 2000, height: 2500, ratio: '4:5', orientation: '直式', environment: '室內' },
    { id: 'p20', no: 20, series: 'Series 9', name: '戶外網格屏 25', size: '1000 × 5000', width: 1000, height: 5000, ratio: '1:5', orientation: '直式', environment: '戶外' },
    { id: 'p21', no: 21, series: 'Series 9', name: '戶外網格屏 50', size: '1000 × 10000', width: 1000, height: 10000, ratio: '1:10', orientation: '直式', environment: '戶外' }
];
