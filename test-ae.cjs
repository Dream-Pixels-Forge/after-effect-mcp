#target aftereffects
var f = new File("C:\\Users\\Patrick\\AppData\\Local\\Temp\\after-effect-mcp\\test-result.json");
f.encoding = "UTF-8";
f.open("w");
f.write('{"test":"hello"}');
f.close();
app.exitCode = 0;