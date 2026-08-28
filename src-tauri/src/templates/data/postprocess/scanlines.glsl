void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 base = 0.5 + 0.5 * cos(iTime * 0.4 + uv.xyx * vec3(5.0, 5.0, 4.0) + vec3(0.0, 2.1, 4.2));
    base = pow(base, vec3(0.8));

    float scanFreq = iResolution.y * 1.2;
    float scanFactor = 0.78 + 0.22 * sin(uv.y * scanFreq);

    float rollPos = fract(iTime * 0.13);
    float rollDist = abs(fract(uv.y - rollPos + 0.5) - 0.5);
    float rollBand = exp(-rollDist * rollDist * 380.0);

    float apM = mod(fragCoord.x, 3.0);
    vec3 aperture = vec3(step(apM, 1.0), step(1.0, apM) * step(apM, 2.0), step(2.0, apM));
    vec3 apGain = vec3(0.80) + aperture * 0.20;

    vec3 col = base * scanFactor;
    col += base * rollBand * 0.30;
    col *= apGain;

    col *= 1.0 - 0.30 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}
